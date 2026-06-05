const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const {
  readDashboardState: readStoredDashboardState,
  readMoonCache,
  listMoonSources,
  rememberTelegramChat,
  setTelegramDailyEnabled,
  listTelegramDailyChats,
  closeDay,
  listClosures
} = require("./storage");

const envPath = path.join(__dirname, ".env");

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const moonCookie = process.env.MOON_COOKIE_HEADER;
const moonSession = process.env.MOON_SESSION_ID;
const moonCsrf = process.env.MOON_CSRF_TOKEN;

const telegramBase = `https://api.telegram.org/bot${token}`;
const telegramCodeVersion = "live-formula-v6-webhook-watchdog";
const telegramTokenScope = new AsyncLocalStorage();
const moonUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
const cachePath = path.join(__dirname, "moon-cache.json");
const dashboardStatePath = path.join(__dirname, "dashboard-state.json");
const dashboardStateUrl = process.env.DASHBOARD_STATE_URL || process.env.RENDER_DASHBOARD_URL || "";
const publicBaseUrl = (process.env.BOZOK_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const moonCacheMaxAgeMs = Number(process.env.MOON_CACHE_MAX_AGE_MS || 30000);
const telegramRuntime = {
  startedAt: new Date().toISOString(),
  lastUpdateAt: "",
  lastCommand: "",
  lastChatType: "",
  lastError: "",
  webhookUrl: "",
  webhookExpectedUrl: "",
  webhookLastCheckAt: "",
  webhookLastConfiguredAt: "",
  webhookLastError: "",
  webhookPendingUpdateCount: 0,
  webhookStatus: "unknown",
  lastDailySnapshotAt: "",
  lastDailySentDate: "",
  lastDailyArchiveDate: "",
  lastLimitAlertAt: "",
  dailyScheduler: "stopped"
};

const dailySnapshotPath = path.join(__dirname, "telegram-daily-snapshots.json");
const dailyReportEnabled = process.env.TELEGRAM_DAILY_REPORT_ENABLED !== "0";
const dailyReportTime = process.env.TELEGRAM_DAILY_REPORT_TIME || "00:01";
const dailySnapshotIntervalMs = Math.max(1000, Number(process.env.TELEGRAM_DAILY_SNAPSHOT_MS || 1000));
const accountLimitAmount = Math.max(1000, Number(process.env.TELEGRAM_ACCOUNT_LIMIT_AMOUNT || 250000));
const limitAlertEnabled = process.env.TELEGRAM_ACCOUNT_LIMIT_ENABLED !== "0";
const limitAlertIntervalMs = Math.max(5000, Number(process.env.TELEGRAM_ACCOUNT_LIMIT_CHECK_MS || 30000));
let dailySnapshotTimer = null;
let dailyDispatchTimer = null;
let dailySnapshots = readJson(dailySnapshotPath, {});
const limitAlertPath = path.join(__dirname, "telegram-limit-alerts.json");
let limitAlertTimer = null;
let limitAlertState = readJson(limitAlertPath, {});
let lastDashboardState = null;

function withTimeout(promise, timeoutMs, label = "timeout") {
  let timer = null;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), timeoutMs);
    })
  ]);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}, settings = {}) {
  const attempts = Math.max(1, Number(settings.attempts || 2));
  const timeoutMs = Math.max(1000, Number(settings.timeoutMs || 10000));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      return { response, data };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(250 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("fetch failed");
}

function cookieHeader() {
  if (moonCookie) return moonCookie;
  if (moonSession && moonCsrf) return `session_id=${moonSession}; csrf_token=${moonCsrf}`;
  return "";
}

async function telegram(method, payload) {
  const scopedToken = telegramTokenScope.getStore()?.token || token;
  const base = scopedToken === token ? telegramBase : `https://api.telegram.org/bot${scopedToken}`;
  const { data } = await fetchJsonWithRetry(`${base}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, { attempts: 3, timeoutMs: 12000 });
  if (!data.ok) throw new Error(data.description || `Telegram ${method} hatası`);
  return data.result;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  });
}

async function fetchMoonDepartments() {
  const cachedRecord = await readMoonCacheRecord();
  const cachedDepartments = departmentsFromPayload(cachedRecord?.payload);
  if (cachedDepartments.length) return cachedDepartments;

  const cookie = cookieHeader();
  if (!cookie) {
    throw new Error("Moon cache yok. Render Moon bot verisi henüz gelmemiş; /durum ile veri akışını kontrol et.");
  }

  const { response, data: payload } = await fetchJsonWithRetry(moonUrl, {
    headers: {
      "Accept": "application/json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Origin": "https://moon.aypay.co",
      "Referer": "https://moon.aypay.co/",
      "Cookie": cookie
    }
  }, { attempts: 2, timeoutMs: 8000 });

  if (!response.ok) {
    throw new Error(`Moon API ${response.status} döndürdü. Session güncel olmayabilir.`);
  }

  return departmentsFromPayload(payload);
}

function departmentsFromPayload(payload) {
  return payload?.data?.departments || payload?.departments || [];
}

function moonRecordAgeMs(record) {
  const capturedAt = Date.parse(record?.payload?.bozokLive?.capturedAt || "") || 0;
  const updatedAt = Date.parse(record?.updatedAt || "") || 0;
  const timestamp = Number(record?.payload?.timestamp || 0) * 1000;
  const time = Math.max(capturedAt, updatedAt, timestamp);
  return time ? Date.now() - time : Number.POSITIVE_INFINITY;
}

function isFreshMoonRecord(record) {
  return Boolean(record?.payload) && moonRecordAgeMs(record) <= moonCacheMaxAgeMs;
}

async function readCachedDepartments() {
  try {
    const stored = await readMoonCache();
    const storedDepartments = departmentsFromPayload(stored?.payload);
    if (storedDepartments.length && isFreshMoonRecord(stored)) return storedDepartments;
    if (!fs.existsSync(cachePath)) return [];
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return isFreshMoonRecord(cached) ? departmentsFromPayload(cached?.payload) : [];
  } catch {
    return [];
  }
}

async function readMoonCacheRecord() {
  try {
    const stored = await readMoonCache();
    if (isFreshMoonRecord(stored)) return stored;
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (isFreshMoonRecord(cached)) return cached;
    }
    if (publicBaseUrl) {
      const { response, data: payload } = await fetchJsonWithRetry(
        `${publicBaseUrl}/api/moon-cache`,
        { headers: { "Accept": "application/json" } },
        { attempts: 2, timeoutMs: 5000 }
      );
      if (response.ok) {
        const record = { payload, updatedAt: payload?.bozokLive?.capturedAt || new Date().toISOString() };
        if (departmentsFromPayload(payload).length && isFreshMoonRecord(record)) {
          return record;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function trMoney(value, fraction = 2) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction
  }).format(Number(value) || 0);
}

function trNumber(value) {
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 0
  }).format(Number(value) || 0);
}

function compactMoney(value) {
  return trMoney(thousandFloor(value), 0);
}

function thousandFloor(value) {
  const amount = Math.floor(Number(value) || 0);
  return amount >= 1000 ? Math.floor(amount / 1000) * 1000 : 0;
}

function parseAmount(value) {
  if (typeof value === "number") return value;
  return Number(String(value || "0").replace(/[^\d,-]/g, "").replace(",", ".")) || 0;
}

function clean(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeCommand(raw = "") {
  const command = String(raw)
    .split("@")[0]
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .toLocaleLowerCase("tr-TR");
  return command;
}

function transactionItems(cache, key) {
  if (key === "withdrawals") {
    const partials = cache?.payload?.bozokLive?.transactions?.withdrawalPartials;
    if (Array.isArray(partials?.payments) && partials.payments.length) return partials.payments;
  }
  const source = cache?.payload?.bozokLive?.transactions?.[key] || {};
  if (Array.isArray(source?.data?.transactions)) return source.data.transactions;
  if (Array.isArray(source?.transactions)) return source.transactions;
  return [];
}

function transactionTotal(items) {
  return items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function transactionDate(item) {
  const raw = String(
    item.date
    || item.completedAt
    || item.approvedAt
    || item.assignedAt
    || item.createdAt
    || item.updatedAt
    || item.requestDate
    || item.created_at
    || ""
  );
  const trDate = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (trDate) return `${trDate[3]}-${trDate[2]}-${trDate[1]}`;
  return raw.slice(0, 10);
}

function isCompletedTransaction(item) {
  const status = String(item.status || item.state || "").toLocaleLowerCase("tr-TR");
  return ["completed", "approved", "success", "succeeded", "onaylandi", "onaylandı"].includes(status);
}

function reportDateFromCache(cache) {
  const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
  const d = daily(departments[0] || {});
  return String(d.date || new Date().toISOString()).slice(0, 10);
}

function officialTransactionItems(cache, kind) {
  const reportDate = reportDateFromCache(cache);
  return transactionItems(cache, kind).filter(item => (!transactionDate(item) || transactionDate(item) === reportDate) && isCompletedTransaction(item));
}

function transactionAccountLabel(item) {
  return String(item.accountLabel || [item.bank, item.account].filter(Boolean).join(" / ") || item.bank || item.account || "Hesap bilgisi yok").trim();
}

function groupTransactionsByAccount(items) {
  const map = new Map();
  for (const item of items) {
    const label = transactionAccountLabel(item);
    const current = map.get(label) || { label, total: 0, count: 0 };
    current.total += Number(item.amount) || 0;
    current.count += 1;
    map.set(label, current);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function heatLevel(total, limit = accountLimitAmount) {
  const ratio = limit > 0 ? total / limit : 0;
  if (ratio >= 1) return { icon: "🔥", label: "limit üstü", ratio };
  if (ratio >= 0.7) return { icon: "🟠", label: "yoğun", ratio };
  if (ratio >= 0.35) return { icon: "🟡", label: "ısınmış", ratio };
  return { icon: "🟢", label: "rahat", ratio };
}

function heatBar(ratio) {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function accountHeatRows(cache, kind = "deposits") {
  const items = officialTransactionItems(cache, kind);
  return groupTransactionsByAccount(items).map(item => ({
    ...item,
    ...heatLevel(item.total)
  }));
}

async function readDashboardState() {
  let storedError = "";
  try {
    const storedState = await withTimeout(
      readStoredDashboardState({ allowFallback: true }),
      Number(process.env.TELEGRAM_DASHBOARD_DB_WAIT_MS || 2500),
      "dashboard-db-read-timeout"
    );
    if (storedState) {
      lastDashboardState = storedState;
      return storedState;
    }
  } catch (error) {
    storedError = error.message;
    try {
      const mirroredState = await readStoredDashboardState({ allowFallback: true, skipDatabase: true });
      if (mirroredState) {
        lastDashboardState = mirroredState;
        return mirroredState;
      }
    } catch {}
  }

  const stateUrls = [
    dashboardStateUrl,
    publicBaseUrl ? `${publicBaseUrl}/api/dashboard-state` : ""
  ].filter(Boolean);

  for (const stateUrl of [...new Set(stateUrls)]) {
    try {
      const url = stateUrl.endsWith("/api/dashboard-state")
        ? stateUrl
        : `${stateUrl.replace(/\/+$/, "")}/api/dashboard-state`;
      const { response, data: payload } = await fetchJsonWithRetry(url, {}, { attempts: 2, timeoutMs: 5000 });
      if (response.ok) {
        lastDashboardState = payload.state || payload;
        return lastDashboardState;
      }
    } catch {
      // Render can be waking up; local storage fallback below keeps commands alive.
    }
  }

  if (fs.existsSync(dashboardStatePath)) {
    lastDashboardState = JSON.parse(fs.readFileSync(dashboardStatePath, "utf8"));
    return lastDashboardState;
  }

  if (lastDashboardState) return lastDashboardState;
  throw new Error(`Dashboard ortak kaydı yok. ${storedError ? `Son DB hatası: ${storedError}. ` : ""}Panelde doğru veriyi olan cihazdan bir kere kaydet.`);
}

function vaultTotalFromState(state, vaultKey) {
  return Object.values(state.vaults?.[vaultKey]?.sets || {})
    .flat()
    .reduce((sum, [, balance]) => sum + thousandFloor(balance), 0);
}

function reportValue(state, key) {
  return thousandFloor(state.latestReport?.[key] || 0);
}

function reconciliationValue(state, row, field) {
  const source = row.auto?.[field];
  if (!source) return parseAmount(row[field]);
  if (source.startsWith("vault:")) return vaultTotalFromState(state, source.slice(6));
  if (source === "reportKasa") return reportValue(state, "kasa");
  if (source === "reportKomisyon") return reportValue(state, "komisyon");
  return parseAmount(row[field]);
}

function kasaFormula(state) {
  const rows = state.reconciliationRows || [];
  const gelir = rows.reduce((sum, row) => sum + reconciliationValue(state, row, "gelir"), 0);
  const kasa = rows.reduce((sum, row) => sum + reconciliationValue(state, row, "kasa"), 0);
  const komisyon = rows
    .filter(row => row.label === "Komisyon Tutarı")
    .reduce((sum, row) => sum + reconciliationValue(state, row, "devir"), 0);
  const dununBorcu = rows
    .filter(row => row.group === "borcDusum")
    .reduce((sum, row) => sum + reconciliationValue(state, row, "devir"), 0);
  const dununAlacagi = rows
    .filter(row => row.group === "alacak")
    .reduce((sum, row) => sum + reconciliationValue(state, row, "devir"), 0);
  const giderRows = rows
    .filter(row => row.group === "gider")
    .map(row => ({ label: row.label, value: reconciliationValue(state, row, "devir") }));
  const gider = giderRows.reduce((sum, row) => sum + row.value, 0);
  const borcKom = dununBorcu - komisyon - dununAlacagi;
  const kalmasiGereken = gider + borcKom;
  const kalan = kasa - gelir;
  const fark = kalmasiGereken - kalan;

  return { gelir, kasa, komisyon, dununBorcu, dununAlacagi, borcKom, gider, giderRows, kalmasiGereken, kalan, fark };
}

function vaultReport(state, vaultKey, label) {
  const vault = state.vaults?.[vaultKey];
  if (!vault) return `${label} kasası bulunamadı.`;
  const total = vaultTotalFromState(state, vaultKey);
  const setLines = Object.entries(vault.sets || {}).map(([owner, accounts]) => {
    const setTotal = accounts.reduce((sum, [, balance]) => sum + thousandFloor(balance), 0);
    return `• ${clean(owner)}: <b>${trMoney(setTotal, 0)}</b>`;
  });
  return [
    `💼 <b>${clean(label)} KASA</b>`,
    "━━━━━━━━━━━━━━━━",
    `Toplam: <b>${trMoney(total, 0)}</b>`,
    "",
    ...setLines
  ].join("\n").trim();
}

function anlikKasaReport(state) {
  const formula = kasaFormula(state);
  return [
    "⚡ <b>ANLIK KASA</b>",
    "━━━━━━━━━━━━━━━━",
    `Panel Kasa: <b>${trMoney(formula.kasa, 0)}</b>`,
    `Elimizdeki Kasa: <b>${trMoney(formula.gelir, 0)}</b>`,
    `Gider: <b>${trMoney(formula.gider, 0)}</b>`,
    `Dünkü Borç-Kom: <b>${trMoney(formula.borcKom, 0)}</b>`,
    `Kalması Gereken: <b>${trMoney(formula.kalmasiGereken, 0)}</b>`,
    `Kalan: <b>${trMoney(formula.kalan, 0)}</b>`,
    `Fark: <b>${trMoney(formula.fark, 0)}</b>`,
    "",
    `Atlas: ${trMoney(vaultTotalFromState(state, "atlas"), 0)}`,
    `Ecem: ${trMoney(vaultTotalFromState(state, "ecem"), 0)}`,
    `Aslan: ${trMoney(vaultTotalFromState(state, "aslan"), 0)}`,
    `Ares: ${trMoney(vaultTotalFromState(state, "ares"), 0)}`
  ].join("\n");
}

function giderReport(state) {
  const formula = kasaFormula(state);
  const detail = formula.giderRows
    .filter(row => row.value)
    .map(row => `• ${clean(row.label)}: <b>${trMoney(row.value, 0)}</b>`);
  return [
    "🧾 <b>ANLIK GİDER</b>",
    "━━━━━━━━━━━━━━━━",
    `Gider Toplamı: <b>${trMoney(formula.gider, 0)}</b>`,
    "",
    ...(detail.length ? detail : ["Manuel gider girilmemiş."]),
    "",
    `Komisyon: <b>${trMoney(formula.komisyon, 0)}</b>`,
    `Dünün Borcu: <b>${trMoney(formula.dununBorcu, 0)}</b>`,
    `Dünün Alacağı: <b>${trMoney(formula.dununAlacagi, 0)}</b>`,
    `Dünkü Borç-Kom: <b>${trMoney(formula.borcKom, 0)}</b>`
  ].join("\n");
}

function departmentName(item) {
  return item.departmentName || item.name || "-";
}

function departmentCode(item) {
  return item.departmentCode || item.code || "-";
}

function daily(item) {
  return item.balances?.dailyBalance || {};
}

function trDateTime(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  const day = date.toLocaleDateString("tr-TR", { timeZone: "Europe/Istanbul" });
  const time = new Date().toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul" });
  return `${day} ${time}`;
}

function ageText(dateValue) {
  const ageMs = Date.now() - (Date.parse(dateValue || "") || 0);
  if (!dateValue || !Number.isFinite(ageMs)) return "yok";
  if (ageMs < 2000) return "anlık";
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)} sn`;
  return `${Math.floor(ageMs / 60000)} dk`;
}

function istanbulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function istanbulDateKey(date = new Date()) {
  const parts = istanbulParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function istanbulTimeText(date = new Date()) {
  const parts = istanbulParts(date);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function previousDailyDateKey(date = new Date()) {
  return istanbulDateKey(new Date(date.getTime() - 10 * 60 * 1000));
}

function parseDailyReportTime() {
  const match = String(dailyReportTime).match(/^(\d{1,2})[:.](\d{2})$/);
  const hour = Math.min(23, Math.max(0, Number(match?.[1] ?? 0)));
  const minute = Math.min(59, Math.max(0, Number(match?.[2] ?? 1)));
  return { hour, minute };
}

function msUntilNextDailyReport() {
  const now = new Date();
  const parts = istanbulParts(now);
  const { hour, minute } = parseDailyReportTime();
  let target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 3, minute, 5);
  if (target <= now.getTime()) {
    target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1, hour - 3, minute, 5);
  }
  return Math.max(1000, target - now.getTime());
}

function findDepartment(departments, query) {
  if (!query) return departments[0];
  const normalized = query.toLocaleLowerCase("tr-TR");
  return departments.find(item => {
    const name = departmentName(item).toLocaleLowerCase("tr-TR");
    const code = departmentCode(item).toLocaleLowerCase("tr-TR");
    return name.includes(normalized) || code.includes(normalized);
  }) || departments[0];
}

function livePanelReportFromCache(cache, query = "") {
  const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
  const item = findDepartment(departments, query);
  if (!item) return null;
  const d = daily(item);
  const capturedAt = cache?.payload?.bozokLive?.capturedAt || cache?.updatedAt || new Date().toISOString();
  return {
    department: departmentName(item),
    date: String(d.date || item.updatedAt || capturedAt || new Date().toISOString()).slice(0, 10),
    devir: d.openingBalance,
    yatirim: d.depositAmount ?? d.totalDepositAmount,
    cekim: d.withdrawalAmount,
    komisyon: d.totalCommission,
    kasa: d.closingBalance ?? item.kasaBalance,
    sourceTimestamp: cache?.payload?.timestamp || "",
    sourceUpdatedAt: item.updatedAt || "",
    liveCapturedAt: capturedAt,
    liveSeq: cache?.payload?.bozokLive?.seq || "",
    liveDeviceName: cache?.payload?.bozokLive?.deviceName || "",
    savedAt: capturedAt
  };
}

function withLivePanelReport(state, cache, query = "") {
  const liveReport = livePanelReportFromCache(cache, query);
  if (!state || !liveReport) return state;
  const liveClock = Date.parse(liveReport.liveCapturedAt || liveReport.savedAt || "") || Date.now();
  return {
    ...state,
    latestReport: {
      ...(state.latestReport || {}),
      ...liveReport
    },
    sectionVersions: {
      ...(state.sectionVersions || {}),
      report: Math.max(Number(state.sectionVersions?.report || 0), liveClock)
    }
  };
}

async function readLiveFormulaState(query = "") {
  const [state, cache] = await Promise.all([
    readDashboardState(),
    readMoonCacheRecord()
  ]);
  if (!cache?.payload) {
    throw new Error(`Moon canlı verisi taze değil. Son ${Math.round(moonCacheMaxAgeMs / 1000)} sn içinde otomasyon cache yazmalı.`);
  }
  return withLivePanelReport(state, cache, query);
}

function endDayReport(item) {
  const d = daily(item);
  const date = String(d.date || new Date().toISOString()).slice(0, 10);

  return [
    "<b>AyPAY</b>",
    "📋 <b>ANLIK PANEL BAKİYE BİLGİLERİ</b>",
    "━━━━━━━━━━━━━━━━",
    `📍 <b>department</b>`,
    `📅 ${clean(date)}`,
    "",
    `DEVİR        <b>${trMoney(d.openingBalance)}</b>`,
    `YATIRIM      <b>${trMoney(d.depositAmount ?? d.totalDepositAmount)}</b>`,
    `ÇEKİM        <b>${trMoney(d.withdrawalAmount)}</b>`,
    `YAT. KOM.    <b>${trMoney(d.totalCommission)}</b>`,
    "",
    `KASA         <b>${trMoney(d.closingBalance ?? item.kasaBalance)}</b>`,
    "",
    `<i>${clean(departmentName(item))} / ${clean(departmentCode(item))}</i>`
  ].join("\n");
}

function kasaPanelReport(item) {
  const d = daily(item);
  return [
    "📊 <b>ANLIK RAPOR</b>",
    "━━━━━━━━━━━━━━━━━━━━━",
    "📍 <b>department</b>",
    `🕐 ${clean(trDateTime(d.date))}`,
    "",
    `DEVİR         <b>${trMoney(d.openingBalance)}</b>`,
    "",
    `YATIRIM       <b>${trMoney(d.depositAmount ?? d.totalDepositAmount)}</b>`,
    `ÇEKİM         <b>${trMoney(d.withdrawalAmount)}</b>`,
    "",
    `YAT. KOM.     <b>${trMoney(d.totalCommission)}</b>`,
    "",
    `KASA          <b>${trMoney(d.closingBalance ?? item.kasaBalance)}</b>`
  ].join("\n");
}

function dailyClosingReportText(state, department, cache, dateKey, capturedAt) {
  const formula = kasaFormula(state);
  const d = department ? daily(department) : {};
  const panelLines = department ? [
    "📊 <b>PANEL BAKİYESİ</b>",
    `DEVİR        <b>${trMoney(d.openingBalance, 0)}</b>`,
    `YATIRIM      <b>${trMoney(d.depositAmount ?? d.totalDepositAmount, 0)}</b>`,
    `ÇEKİM        <b>${trMoney(d.withdrawalAmount, 0)}</b>`,
    `YAT. KOM.    <b>${trMoney(d.totalCommission, 0)}</b>`,
    `KASA         <b>${trMoney(d.closingBalance ?? department.kasaBalance, 0)}</b>`
  ] : [
    "📊 <b>PANEL BAKİYESİ</b>",
    "Moon panel verisi alınamadı."
  ];

  return [
    "🌙 <b>DÜN KAPANIŞ RAPORU</b>",
    "━━━━━━━━━━━━━━━━",
    `Tarih: <b>${clean(dateKey)}</b>`,
    `Snapshot: <b>${clean(istanbulTimeText(new Date(capturedAt)))}</b>`,
    "",
    "⚡ <b>KASA FORMÜLÜ</b>",
    `Panel Kasa: <b>${trMoney(formula.kasa, 0)}</b>`,
    `Elimizdeki Kasa: <b>${trMoney(formula.gelir, 0)}</b>`,
    `Gider: <b>${trMoney(formula.gider, 0)}</b>`,
    `Dünkü Borç-Kom: <b>${trMoney(formula.borcKom, 0)}</b>`,
    `Kalması Gereken: <b>${trMoney(formula.kalmasiGereken, 0)}</b>`,
    `Kalan: <b>${trMoney(formula.kalan, 0)}</b>`,
    `Fark: <b>${trMoney(formula.fark, 0)}</b>`,
    "",
    "💼 <b>KASA DAĞILIMI</b>",
    `Atlas: <b>${trMoney(vaultTotalFromState(state, "atlas"), 0)}</b>`,
    `Ecem: <b>${trMoney(vaultTotalFromState(state, "ecem"), 0)}</b>`,
    `Aslan: <b>${trMoney(vaultTotalFromState(state, "aslan"), 0)}</b>`,
    `Ares: <b>${trMoney(vaultTotalFromState(state, "ares"), 0)}</b>`,
    "",
    ...panelLines
  ].join("\n");
}

async function refreshDailySnapshot() {
  try {
    const [state, cache] = await Promise.all([readDashboardState(), readMoonCacheRecord()]);
    const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
    const department = findDepartment(departments, process.env.TELEGRAM_DAILY_DEPARTMENT || "");
    const liveState = withLivePanelReport(state, cache, process.env.TELEGRAM_DAILY_DEPARTMENT || "");
    const capturedAt = new Date().toISOString();
    const dateKey = istanbulDateKey(new Date(capturedAt));
    dailySnapshots[dateKey] = {
      dateKey,
      capturedAt,
      text: dailyClosingReportText(liveState, department, cache, dateKey, capturedAt),
      state: liveState
    };
    const keys = Object.keys(dailySnapshots).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 7))) delete dailySnapshots[key];
    writeJson(dailySnapshotPath, dailySnapshots);
    telegramRuntime.lastDailySnapshotAt = capturedAt;
    telegramRuntime.lastError = "";
    return dailySnapshots[dateKey];
  } catch (error) {
    telegramRuntime.lastError = error.message;
    return null;
  }
}

async function archiveDailyClosing(snapshot, dateKey) {
  if (!snapshot?.state || telegramRuntime.lastDailyArchiveDate === dateKey) return null;
  const closure = await closeDay({
    state: snapshot.state,
    date: dateKey,
    actor: "Telegram 00:01",
    archiveOnly: true
  });
  telegramRuntime.lastDailyArchiveDate = dateKey;
  return closure;
}

function envDailyChatIds() {
  return String(process.env.TELEGRAM_DAILY_CHAT_ID || process.env.TELEGRAM_REPORT_CHAT_ID || "")
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function dailyReportTargets() {
  const envIds = envDailyChatIds();
  const stored = await listTelegramDailyChats().catch(() => []);
  return [...new Set([...envIds, ...stored.map(item => item.chatId)].filter(Boolean))];
}

function limitAlertKey(dateKey, row) {
  return `${dateKey}:${row.label}`;
}

async function sendLimitAlerts() {
  if (!limitAlertEnabled || !token) return { sent: 0 };
  const cache = await readMoonCacheRecord();
  if (!cache?.payload) return { sent: 0 };
  const dateKey = reportDateFromCache(cache);
  const hotRows = accountHeatRows(cache, "deposits").filter(row => row.total >= accountLimitAmount);
  if (!hotRows.length) return { sent: 0 };

  if (limitAlertState.dateKey !== dateKey) {
    limitAlertState = { dateKey, sent: {} };
  }

  const unsent = hotRows.filter(row => !limitAlertState.sent?.[limitAlertKey(dateKey, row)]);
  if (!unsent.length) return { sent: 0 };

  const targets = await dailyReportTargets();
  if (!targets.length) return { sent: 0 };

  const text = [
    "🚨 <b>HESAP LİMİT UYARISI</b>",
    "━━━━━━━━━━━━━━━━",
    `Limit: <b>${trMoney(accountLimitAmount, 0)}</b>`,
    "",
    ...unsent.slice(0, 10).map(row => `${row.icon} ${clean(row.label)}: <b>${trMoney(row.total, 0)}</b> <i>${trNumber(row.count)} adet</i>`)
  ].join("\n");

  let sent = 0;
  for (const chatId of targets) {
    try {
      await sendMessage(chatId, text);
      sent += 1;
    } catch (error) {
      telegramRuntime.lastError = error.message;
    }
  }

  if (sent > 0) {
    limitAlertState.sent ||= {};
    for (const row of unsent) limitAlertState.sent[limitAlertKey(dateKey, row)] = new Date().toISOString();
    writeJson(limitAlertPath, limitAlertState);
    telegramRuntime.lastLimitAlertAt = new Date().toISOString();
  }
  return { sent };
}

async function sendDailyClosingReport() {
  const dateKey = previousDailyDateKey();
  const snapshot = dailySnapshots[dateKey] || await refreshDailySnapshot();
  await archiveDailyClosing(snapshot, dateKey).catch(error => {
    telegramRuntime.lastError = error.message;
  });

  const targets = await dailyReportTargets();
  if (!targets.length) {
    telegramRuntime.lastError = "Günlük rapor için kayıtlı Telegram sohbeti yok. Grupta /menu veya /gunlukaktif yaz.";
    return { sent: 0, dateKey };
  }

  const text = snapshot?.dateKey === dateKey
    ? snapshot.text
    : [
      "🌙 <b>DÜN KAPANIŞ RAPORU</b>",
      "━━━━━━━━━━━━━━━━",
      `Tarih: <b>${clean(dateKey)}</b>`,
      "Gece yarısı snapshot bulunamadı; mevcut son veriden raporlandı.",
      "",
      snapshot?.text || "Rapor üretilemedi."
    ].join("\n");

  let sent = 0;
  for (const chatId of targets) {
    try {
      await sendMessage(chatId, text);
      sent += 1;
    } catch (error) {
      telegramRuntime.lastError = error.message;
    }
  }
  telegramRuntime.lastDailySentDate = dateKey;
  return { sent, dateKey };
}

function scheduleDailyDispatch() {
  clearTimeout(dailyDispatchTimer);
  if (!dailyReportEnabled || !token) {
    telegramRuntime.dailyScheduler = "disabled";
    return;
  }
  const delayMs = msUntilNextDailyReport();
  telegramRuntime.dailyScheduler = `next:${new Date(Date.now() + delayMs).toISOString()}`;
  dailyDispatchTimer = setTimeout(() => {
    sendDailyClosingReport()
      .catch(error => {
        telegramRuntime.lastError = error.message;
      })
      .finally(scheduleDailyDispatch);
  }, delayMs);
}

function startDailyReportScheduler() {
  if (!dailyReportEnabled || !token) {
    telegramRuntime.dailyScheduler = "disabled";
    return;
  }
  if (!dailySnapshotTimer) {
    refreshDailySnapshot().catch(() => {});
    dailySnapshotTimer = setInterval(() => {
      refreshDailySnapshot().catch(() => {});
    }, dailySnapshotIntervalMs);
  }
  scheduleDailyDispatch();
  startLimitAlertScheduler();
}

function startLimitAlertScheduler() {
  if (!limitAlertEnabled || !token || limitAlertTimer) return;
  const tick = () => {
    sendLimitAlerts()
      .catch(error => {
        telegramRuntime.lastError = error.message;
      })
      .finally(() => {
        limitAlertTimer = setTimeout(tick, limitAlertIntervalMs);
      });
  };
  limitAlertTimer = setTimeout(tick, Math.min(limitAlertIntervalMs, 10000));
}

function instantReport(departments) {
  const lines = [
    "⚡ <b>ANLIK DEPARTMAN DURUMU</b>",
    "━━━━━━━━━━━━━━━━"
  ];

  for (const item of departments.slice(0, 12)) {
    const d = daily(item);
    lines.push(
      `<b>${clean(departmentName(item))}</b> (${clean(departmentCode(item))})`,
      `Kasa: <b>${trMoney(d.closingBalance ?? item.kasaBalance)}</b>`,
      `Yatırım: ${trMoney(d.depositAmount ?? d.totalDepositAmount, 0)}  Çekim: ${trMoney(d.withdrawalAmount, 0)}`,
      ""
    );
  }

  return lines.join("\n").trim();
}

function departmentList(departments) {
  return [
    "🏢 <b>DEPARTMANLAR</b>",
    "━━━━━━━━━━━━━━━━",
    ...departments.map(item => `• ${clean(departmentName(item))} / ${clean(departmentCode(item))}`)
  ].join("\n");
}

async function statusReport() {
  const [state, cache] = await Promise.all([
    readDashboardState(),
    readMoonCacheRecord()
  ]);
  const liveState = withLivePanelReport(state, cache);
  const sources = await listMoonSources(60000);
  const live = cache?.payload?.bozokLive || {};
  const report = liveState?.latestReport || {};
  const formula = kasaFormula(liveState);
  const sourceText = sources.length
    ? sources.map(item => `${clean(item.deviceName)} (${ageText(item.updatedAt)})`).join(", ")
    : "aktif cihaz yok";
  return [
    "🛰️ <b>SİSTEM DURUMU</b>",
    "━━━━━━━━━━━━━━━━",
    `Moon Veri: <b>${ageText(live.capturedAt)}</b>`,
    `Cihaz: <b>${clean(live.deviceName || "yok")}</b>`,
    `Aktif Kaynaklar: <b>${sourceText}</b>`,
    `Seq: <b>${clean(String(live.seq || "-"))}</b>`,
    `DB: <b>${process.env.DATABASE_URL ? "bağlı" : "bağlı değil"}</b>`,
    "",
    `Dashboard: <b>${ageText(state?.savedAt)}</b>`,
    `Son Panel Kasa: <b>${trMoney(report.kasa || 0, 0)}</b>`,
    `Fark: <b>${trMoney(formula.fark, 0)}</b>`,
    state?.dayClosed ? `Kapanış: <b>${clean(state.dayClosed.businessDate || "-")}</b>` : "Kapanış: açık",
    `Limit Alarmı: <b>${limitAlertEnabled ? trMoney(accountLimitAmount, 0) : "kapalı"}</b>`,
    `Son Limit Uyarısı: <b>${ageText(telegramRuntime.lastLimitAlertAt)}</b>`,
    `Son Arşiv: <b>${clean(telegramRuntime.lastDailyArchiveDate || "-")}</b>`
  ].join("\n");
}

async function transactionSummaryReport() {
  const cache = await readMoonCacheRecord();
  const activeDeposits = transactionItems(cache, "activeDeposits");
  const activeWithdrawals = transactionItems(cache, "activeWithdrawals");
  const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
  const d = daily(departments[0] || {});
  const depositApprovedCount = Number(d.depositCount ?? 0) || 0;
  const depositTotalCount = Number(d.totalDepositCount ?? depositApprovedCount) || depositApprovedCount;
  const depositPendingCount = Number(d.pendingDepositCount ?? Math.max(0, depositTotalCount - depositApprovedCount)) || 0;
  const withdrawalApprovedCount = Number(d.withdrawalCount ?? 0) || 0;
  return [
    "🔎 <b>İŞLEM ÖZETİ</b>",
    "━━━━━━━━━━━━━━━━",
    `Yatırım Onaylanan: <b>${trMoney(d.depositAmount, 0)}</b> / <b>${trNumber(depositApprovedCount)} adet</b>`,
    `Yatırım Toplam: <b>${trMoney(d.totalDepositAmount ?? d.depositAmount, 0)}</b> / <b>${trNumber(depositTotalCount)} adet</b>`,
    `Yatırım Bekleyen: <b>${trMoney(d.pendingDepositAmount, 0)}</b> / <b>${trNumber(depositPendingCount)} adet</b>`,
    `Çekim Onaylanan: <b>${trMoney(d.withdrawalAmount, 0)}</b> / <b>${trNumber(withdrawalApprovedCount)} adet</b>`,
    "",
    `Aktif Yatırım: <b>${trNumber(activeDeposits.length)}</b> / <b>${trMoney(transactionTotal(activeDeposits), 0)}</b>`,
    `Aktif Çekim: <b>${trNumber(activeWithdrawals.length)}</b> / <b>${trMoney(transactionTotal(activeWithdrawals), 0)}</b>`
  ].join("\n");
}

async function transactionAccountReport(kind = "deposits") {
  const cache = await readMoonCacheRecord();
  const items = officialTransactionItems(cache, kind);
  const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
  const d = daily(departments[0] || {});
  const officialAmount = kind === "withdrawals" ? d.withdrawalAmount : d.depositAmount;
  const officialCount = kind === "withdrawals" ? d.withdrawalCount : d.depositCount;
  const grouped = groupTransactionsByAccount(items).slice(0, 15);
  const title = kind === "withdrawals" ? "ÇEKİM HESAP DAĞILIMI" : "YATIRIM HESAP DAĞILIMI";
  const empty = kind === "withdrawals" ? "Çekim işlem detayı yok." : "Yatırım işlem detayı yok.";
  return [
    `${kind === "withdrawals" ? "📤" : "📥"} <b>${title}</b>`,
    "━━━━━━━━━━━━━━━━",
    `Panel Onaylanan: <b>${trMoney(officialAmount, 0)}</b> / <b>${trNumber(officialCount || 0)} adet</b>`,
    `Listede Yakalanan: <b>${trMoney(transactionTotal(items), 0)}</b> / <b>${trNumber(items.length)} adet</b>`,
    "",
    grouped.length
      ? grouped.map(item => `• ${clean(item.label)}: <b>${trMoney(item.total, 0)}</b> <i>${trNumber(item.count)} adet</i>`).join("\n")
      : empty
  ].join("\n");
}

async function accountHeatMapReport() {
  const cache = await readMoonCacheRecord();
  const rows = accountHeatRows(cache, "deposits");
  const hot = rows.filter(row => row.total >= accountLimitAmount).length;
  const warm = rows.filter(row => row.total >= accountLimitAmount * 0.7 && row.total < accountLimitAmount).length;
  return [
    "🌡️ <b>HESAP ISI HARİTASI</b>",
    "━━━━━━━━━━━━━━━━",
    `Limit: <b>${trMoney(accountLimitAmount, 0)}</b>`,
    `Riskli: <b>${trNumber(hot)}</b>  Yoğun: <b>${trNumber(warm)}</b>`,
    "",
    rows.length
      ? rows.slice(0, 15).map(row => `${row.icon} ${clean(row.label)}\n${heatBar(row.ratio)} <b>${trMoney(row.total, 0)}</b> <i>${trNumber(row.count)} adet</i>`).join("\n")
      : "Bugün onaylanan yatırım detayı yakalanmadı."
  ].join("\n");
}

async function limitGuardReport() {
  const cache = await readMoonCacheRecord();
  const rows = accountHeatRows(cache, "deposits");
  const hot = rows.filter(row => row.total >= accountLimitAmount);
  const warning = rows.filter(row => row.total >= accountLimitAmount * 0.7 && row.total < accountLimitAmount);
  return [
    "🛡️ <b>LİMİT KORUMA</b>",
    "━━━━━━━━━━━━━━━━",
    `Limit: <b>${trMoney(accountLimitAmount, 0)}</b>`,
    `Alarm: <b>${limitAlertEnabled ? "aktif" : "kapalı"}</b>`,
    "",
    hot.length
      ? hot.slice(0, 10).map(row => `🚨 ${clean(row.label)}: <b>${trMoney(row.total, 0)}</b> <i>${trNumber(row.count)} adet</i>`).join("\n")
      : "Limit üstü hesap yok.",
    warning.length ? "\n<b>Yaklaşanlar</b>\n" + warning.slice(0, 8).map(row => `• ${clean(row.label)}: <b>${trMoney(row.total, 0)}</b>`).join("\n") : ""
  ].filter(Boolean).join("\n");
}

async function archiveListReport() {
  const closures = await listClosures(7);
  return [
    "🗄️ <b>GÜN SONU ARŞİVİ</b>",
    "━━━━━━━━━━━━━━━━",
    closures.length
      ? closures.map(item => {
        const summary = item.summary || {};
        return [
          `<b>${clean(item.businessDate || "-")}</b>`,
          `Kasa: <b>${trMoney(summary.kasa, 0)}</b>  Fark: <b>${trMoney(summary.fark, 0)}</b>`,
          `Gelir: ${trMoney(summary.gelir, 0)}  Gider: ${trMoney(summary.gider, 0)}`
        ].join("\n");
      }).join("\n\n")
      : "Henüz arşiv kaydı yok. 00:01 raporu sonrası otomatik oluşacak."
  ].join("\n");
}

function helpText() {
  return [
    "Komutlar:",
    "/menu veya /menü - butonlu komut merkezi",
    "/m - kısa menü",
    "/anlik - paneldeki anlık kasa formülü",
    "/atlas - Atlas kasa tutarı",
    "/ecem - Ecem kasa tutarı",
    "/aslan - Aslan kasa tutarı",
    "/ares - Ares kasa tutarı",
    "/gider - anlık gider açıklaması",
    "/islem - yatırım/çekim işlem özeti",
    "/yatirimlar - hangi hesaba ne kadar yatırım geldi",
    "/cekimler - hangi hesaptan ne kadar çekim çıktı",
    "/isi - hesap ısı haritası",
    "/limitler - limit koruma raporu",
    "/durum - sistem, veri yaşı ve cihaz bilgisi",
    "/kasa - canlı Moon anlık raporu",
    "/gunsonu - ilk departman anlık panel bakiyesi",
    "/gunsonu Şimşek - seçilen departman anlık panel bakiyesi",
    "/departmanlar - departman listesi",
    "/arsiv - son gün sonu arşivleri",
    "/gunlukaktif - bu sohbete 00:01 kapanış raporu gönder",
    "/gunlukpasif - bu sohbette otomatik kapanış raporunu kapat",
    "/gunluktest - kapanış raporunu şimdi test gönder"
  ].join("\n");
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚡ Anlık Kasa", callback_data: "cmd:anlik" },
        { text: "📊 Panel Rapor", callback_data: "cmd:kasa" }
      ],
      [
        { text: "🧾 Gider", callback_data: "cmd:gider" },
        { text: "🛰️ Durum", callback_data: "cmd:durum" }
      ],
      [
        { text: "🔎 İşlem Özeti", callback_data: "cmd:islem" },
        { text: "📥 Yatırımlar", callback_data: "cmd:yatirimlar" }
      ],
      [
        { text: "📤 Çekimler", callback_data: "cmd:cekimler" }
      ],
      [
        { text: "🌡️ Isı Haritası", callback_data: "cmd:isi" },
        { text: "🛡️ Limitler", callback_data: "cmd:limitler" }
      ],
      [
        { text: "Atlas", callback_data: "cmd:atlas" },
        { text: "Ecem", callback_data: "cmd:ecem" },
        { text: "Aslan", callback_data: "cmd:aslan" },
        { text: "Ares", callback_data: "cmd:ares" }
      ],
      [
        { text: "🏢 Departmanlar", callback_data: "cmd:departmanlar" },
        { text: "📋 Panel Bakiye", callback_data: "cmd:gunsonu" }
      ],
      [
        { text: "🗄️ Arşiv", callback_data: "cmd:arsiv" },
        { text: "🌙 Günlük Test", callback_data: "cmd:gunluktest" }
      ]
    ]
  };
}

async function sendMainMenu(chatId) {
  return sendMessage(chatId, [
    "🎛️ <b>BOZOK KOMUT MERKEZİ</b>",
    "━━━━━━━━━━━━━━━━",
    "İstediğin raporu butondan seç."
  ].join("\n"), {
    reply_markup: menuKeyboard()
  });
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text.startsWith("/")) return;

  const [commandRaw, ...rest] = text.split(/\s+/);
  const command = normalizeCommand(commandRaw);
  const query = rest.join(" ").trim();
  telegramRuntime.lastUpdateAt = new Date().toISOString();
  telegramRuntime.lastCommand = command;
  telegramRuntime.lastChatType = message.chat?.type || "";
  telegramRuntime.lastError = "";
  rememberTelegramChat(message.chat).catch(error => {
    telegramRuntime.lastError = error.message;
  });

  try {
    await dispatchCommand(chatId, command, query);
  } catch (error) {
    telegramRuntime.lastError = error.message;
    await sendMessage(chatId, `Hata: ${clean(error.message)}`).catch(sendError => {
      telegramRuntime.lastError = sendError.message;
    });
  }
}

async function dispatchCommand(chatId, command, query = "") {
  if (["/start", "/help", "/yardim"].includes(command)) {
    await sendMessage(chatId, helpText());
    return;
  }

  if (["/menu", "/m", "/komut"].includes(command)) {
    await sendMainMenu(chatId);
    return;
  }

  if (command === "/anlik") {
    const state = await readLiveFormulaState(query);
    await sendMessage(chatId, anlikKasaReport(state));
    return;
  }

  if (["/atlas", "/ecem", "/aslan", "/ares"].includes(command)) {
    const state = await readDashboardState();
    const vaultKey = command.slice(1);
    await sendMessage(chatId, vaultReport(state, vaultKey, vaultKey.toLocaleUpperCase("tr-TR")));
    return;
  }

  if (command === "/gider") {
    const state = await readLiveFormulaState(query);
    await sendMessage(chatId, giderReport(state));
    return;
  }

  if (command === "/islem") {
    await sendMessage(chatId, await transactionSummaryReport());
    return;
  }

  if (["/yatirimlar", "/yatirim"].includes(command)) {
    await sendMessage(chatId, await transactionAccountReport("deposits"));
    return;
  }

  if (["/cekimler", "/cekim"].includes(command)) {
    await sendMessage(chatId, await transactionAccountReport("withdrawals"));
    return;
  }

  if (["/isi", "/harita", "/isiharitasi"].includes(command)) {
    await sendMessage(chatId, await accountHeatMapReport());
    return;
  }

  if (["/limitler", "/limit", "/limitkoruma"].includes(command)) {
    await sendMessage(chatId, await limitGuardReport());
    return;
  }

  if (command === "/durum") {
    await sendMessage(chatId, await statusReport());
    return;
  }

  if (command === "/kasa") {
    const departments = await fetchMoonDepartments();
    await sendMessage(chatId, kasaPanelReport(findDepartment(departments, query)));
    return;
  }

  if (command === "/departman") {
    const departments = await fetchMoonDepartments();
    await sendMessage(chatId, instantReport(departments));
    return;
  }

  if (command === "/departmanlar") {
    const departments = await fetchMoonDepartments();
    await sendMessage(chatId, departmentList(departments));
    return;
  }

  if (command === "/arsiv") {
    await sendMessage(chatId, await archiveListReport());
    return;
  }

  if (command === "/gunsonu") {
    const departments = await fetchMoonDepartments();
    await sendMessage(chatId, endDayReport(findDepartment(departments, query)));
    return;
  }

  if (command === "/gunlukaktif") {
    await setTelegramDailyEnabled(chatId, true);
    await sendMessage(chatId, "🌙 00:01 dünkü kapanış raporu bu sohbete gönderilecek.");
    return;
  }

  if (command === "/gunlukpasif") {
    await setTelegramDailyEnabled(chatId, false);
    await sendMessage(chatId, "Günlük 00:01 kapanış raporu bu sohbet için kapatıldı.");
    return;
  }

  if (command === "/gunluktest") {
    const snapshot = await refreshDailySnapshot();
    await sendMessage(chatId, snapshot?.text || "Kapanış raporu üretilemedi.");
    return;
  }

  await sendMessage(chatId, helpText());
}

async function handleTelegramUpdate(update, options = {}) {
  const scopedToken = String(options.token || options.tokenOverride || "").trim();
  if (scopedToken) {
    return telegramTokenScope.run({ token: scopedToken }, () => handleTelegramUpdate(update));
  }
  telegramRuntime.lastUpdateAt = new Date().toISOString();
  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }
  const message = update?.message || update?.edited_message || update?.channel_post || {};
  await handleMessage(message);
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = String(callbackQuery.data || "");
  if (!chatId || !data.startsWith("cmd:")) return;

  const command = normalizeCommand(`/${data.slice(4)}`);
  telegramRuntime.lastUpdateAt = new Date().toISOString();
  telegramRuntime.lastCommand = command;
  telegramRuntime.lastChatType = callbackQuery.message?.chat?.type || "";
  telegramRuntime.lastError = "";
  rememberTelegramChat(callbackQuery.message?.chat || {}).catch(error => {
    telegramRuntime.lastError = error.message;
  });

  try {
    await answerCallbackQuery(callbackQuery.id, "Hazırlanıyor").catch(() => {});
    await dispatchCommand(chatId, command);
  } catch (error) {
    telegramRuntime.lastError = error.message;
    await answerCallbackQuery(callbackQuery.id, "Hata oluştu").catch(() => {});
    await sendMessage(chatId, `Hata: ${clean(error.message)}`).catch(sendError => {
      telegramRuntime.lastError = sendError.message;
    });
  }
}

function telegramStatus() {
  return {
    hasToken: Boolean(token),
    codeVersion: telegramCodeVersion,
    startedAt: telegramRuntime.startedAt,
    lastUpdateAt: telegramRuntime.lastUpdateAt,
    lastCommand: telegramRuntime.lastCommand,
    lastChatType: telegramRuntime.lastChatType,
    lastError: telegramRuntime.lastError,
    webhook: {
      status: telegramRuntime.webhookStatus,
      url: telegramRuntime.webhookUrl,
      expectedUrl: telegramRuntime.webhookExpectedUrl,
      lastCheckAt: telegramRuntime.webhookLastCheckAt,
      lastConfiguredAt: telegramRuntime.webhookLastConfiguredAt,
      lastError: telegramRuntime.webhookLastError,
      pendingUpdateCount: telegramRuntime.webhookPendingUpdateCount
    },
    dailyScheduler: telegramRuntime.dailyScheduler,
    lastDailySnapshotAt: telegramRuntime.lastDailySnapshotAt,
    lastDailySentDate: telegramRuntime.lastDailySentDate,
    lastDailyArchiveDate: telegramRuntime.lastDailyArchiveDate,
    lastLimitAlertAt: telegramRuntime.lastLimitAlertAt,
    accountLimitAmount,
    limitAlertEnabled
  };
}

function telegramWebhookUrl(publicUrl) {
  const baseUrl = String(publicUrl || "").replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/telegram-webhook` : "";
}

async function configureWebhook(publicUrl) {
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN yok, Telegram webhook ayarlanmadı.");
    return;
  }

  const baseUrl = String(publicUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    console.log("Public URL yok, Telegram webhook ayarlanmadı.");
    return;
  }

  const url = telegramWebhookUrl(baseUrl);
  await telegram("setWebhook", {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  telegramRuntime.webhookUrl = url;
  telegramRuntime.webhookExpectedUrl = url;
  telegramRuntime.webhookLastConfiguredAt = new Date().toISOString();
  telegramRuntime.webhookLastError = "";
  telegramRuntime.webhookStatus = "configured";
  startDailyReportScheduler();
  console.log(`Telegram webhook aktif: ${url}`);
}

async function ensureTelegramWebhook(publicUrl) {
  if (!token) return { ok: false, skipped: true, reason: "missing-token" };
  const expectedUrl = telegramWebhookUrl(publicUrl);
  if (!expectedUrl) return { ok: false, skipped: true, reason: "missing-public-url" };

  telegramRuntime.webhookExpectedUrl = expectedUrl;
  telegramRuntime.webhookLastCheckAt = new Date().toISOString();
  try {
    const info = await telegram("getWebhookInfo", {});
    telegramRuntime.webhookUrl = info.url || "";
    telegramRuntime.webhookPendingUpdateCount = Number(info.pending_update_count || 0);
    telegramRuntime.webhookLastError = info.last_error_message || "";

    const urlMismatch = telegramRuntime.webhookUrl !== expectedUrl;
    const brokenWebhook = Boolean(info.last_error_message) && !telegramRuntime.webhookUrl;
    if (urlMismatch || brokenWebhook) {
      await configureWebhook(publicUrl);
      telegramRuntime.webhookStatus = "reconfigured";
      return { ok: true, reconfigured: true, reason: urlMismatch ? "url-mismatch" : "webhook-error" };
    }

    telegramRuntime.webhookStatus = info.last_error_message ? "warning" : "ok";
    return {
      ok: true,
      reconfigured: false,
      pendingUpdateCount: telegramRuntime.webhookPendingUpdateCount,
      lastError: telegramRuntime.webhookLastError
    };
  } catch (error) {
    telegramRuntime.webhookStatus = "error";
    telegramRuntime.webhookLastError = error.message;
    telegramRuntime.lastError = error.message;
    throw error;
  }
}

async function poll() {
  if (!token) {
    console.log("TELEGRAM_BOT_TOKEN yok, Telegram bot başlatılmadı.");
    return;
  }

  let offset = 0;
  try {
    await telegram("deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    console.error(`Webhook temizlenemedi: ${error.message}`);
  }

  console.log("Telegram bot çalışıyor.");
  startDailyReportScheduler();

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error(error.message);
      if (String(error.message).includes("webhook is active")) {
        console.log("Webhook aktif, polling bot kapatılıyor.");
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

function startTelegramBot() {
  return poll();
}

if (require.main === module) {
  if (process.env.TELEGRAM_USE_POLLING === "1") {
    startTelegramBot();
  } else {
    console.log("Polling kapalı. Telegram bot Render webhook üzerinden çalışır.");
  }
}

module.exports = { configureWebhook, ensureTelegramWebhook, handleTelegramUpdate, startTelegramBot, telegramStatus };
