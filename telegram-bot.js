const fs = require("node:fs");
const path = require("node:path");
const {
  readDashboardState: readStoredDashboardState,
  readMoonCache,
  listMoonSources,
  rememberTelegramChat,
  setTelegramDailyEnabled,
  listTelegramDailyChats
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
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const moonCookie = process.env.MOON_COOKIE_HEADER;
const moonSession = process.env.MOON_SESSION_ID;
const moonCsrf = process.env.MOON_CSRF_TOKEN;

const telegramBase = `https://api.telegram.org/bot${token}`;
const moonUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
const cachePath = path.join(__dirname, "moon-cache.json");
const dashboardStatePath = path.join(__dirname, "dashboard-state.json");
const dashboardStateUrl = process.env.DASHBOARD_STATE_URL || process.env.RENDER_DASHBOARD_URL || "";
const telegramRuntime = {
  startedAt: new Date().toISOString(),
  lastUpdateAt: "",
  lastCommand: "",
  lastChatType: "",
  lastError: "",
  lastDailySnapshotAt: "",
  lastDailySentDate: "",
  dailyScheduler: "stopped"
};

const dailySnapshotPath = path.join(__dirname, "telegram-daily-snapshots.json");
const dailyReportEnabled = process.env.TELEGRAM_DAILY_REPORT_ENABLED !== "0";
const dailyReportTime = process.env.TELEGRAM_DAILY_REPORT_TIME || "00:01";
const dailySnapshotIntervalMs = Math.max(1000, Number(process.env.TELEGRAM_DAILY_SNAPSHOT_MS || 1000));
let dailySnapshotTimer = null;
let dailyDispatchTimer = null;
let dailySnapshots = readJson(dailySnapshotPath, {});

function cookieHeader() {
  if (moonCookie) return moonCookie;
  if (moonSession && moonCsrf) return `session_id=${moonSession}; csrf_token=${moonCsrf}`;
  return "";
}

async function telegram(method, payload) {
  const response = await fetch(`${telegramBase}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
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
  const cachedDepartments = await readCachedDepartments();
  if (cachedDepartments.length) return cachedDepartments;

  const cookie = cookieHeader();
  if (!cookie) {
    throw new Error("Moon cache yok. Edge'de Moon açıkken userscript köprüsü veriyi localhost'a aktarmalı.");
  }

  const response = await fetch(moonUrl, {
    headers: {
      "Accept": "application/json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Origin": "https://moon.aypay.co",
      "Referer": "https://moon.aypay.co/",
      "Cookie": cookie
    }
  });

  if (!response.ok) {
    throw new Error(`Moon API ${response.status} döndürdü. Session güncel olmayabilir.`);
  }

  const payload = await response.json();
  return payload?.data?.departments || [];
}

async function readCachedDepartments() {
  try {
    const stored = await readMoonCache();
    const storedDepartments = stored?.payload?.data?.departments || stored?.payload?.departments || [];
    if (storedDepartments.length) return storedDepartments;
    if (!fs.existsSync(cachePath)) return [];
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return cached?.payload?.data?.departments || cached?.payload?.departments || [];
  } catch {
    return [];
  }
}

async function readMoonCacheRecord() {
  try {
    const stored = await readMoonCache();
    if (stored?.payload) return stored;
    if (!fs.existsSync(cachePath)) return null;
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return cached?.payload ? cached : null;
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

async function readDashboardState() {
  if (dashboardStateUrl) {
    try {
      const url = dashboardStateUrl.endsWith("/api/dashboard-state")
        ? dashboardStateUrl
        : `${dashboardStateUrl.replace(/\/+$/, "")}/api/dashboard-state`;
      const response = await fetch(url);
      if (response.ok) {
        const payload = await response.json();
        return payload.state || payload;
      }
    } catch {
      // Render can be waking up; local storage fallback below keeps commands alive.
    }
  }

  const storedState = await readStoredDashboardState();
  if (storedState) return storedState;

  if (fs.existsSync(dashboardStatePath)) {
    return JSON.parse(fs.readFileSync(dashboardStatePath, "utf8"));
  }

  throw new Error("Dashboard ortak kaydı yok. Panelde doğru veriyi olan cihazdan bir kere kaydet.");
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
  const borcKom = dununBorcu + dununAlacagi - komisyon;
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
  const live = cache?.payload?.bozokLive || {};
  const source = live.deviceName ? `${live.deviceName} / ${ageText(live.capturedAt)}` : "kaynak yok";
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
    ...panelLines,
    "",
    `Kaynak: <i>${clean(source)}</i>`
  ].join("\n");
}

async function refreshDailySnapshot() {
  try {
    const [state, cache] = await Promise.all([readDashboardState(), readMoonCacheRecord()]);
    const departments = cache?.payload?.data?.departments || cache?.payload?.departments || [];
    const department = findDepartment(departments, process.env.TELEGRAM_DAILY_DEPARTMENT || "");
    const capturedAt = new Date().toISOString();
    const dateKey = istanbulDateKey(new Date(capturedAt));
    dailySnapshots[dateKey] = {
      dateKey,
      capturedAt,
      text: dailyClosingReportText(state, department, cache, dateKey, capturedAt)
    };
    const keys = Object.keys(dailySnapshots).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 7))) delete dailySnapshots[key];
    writeJson(dailySnapshotPath, dailySnapshots);
    telegramRuntime.lastDailySnapshotAt = capturedAt;
    return dailySnapshots[dateKey];
  } catch (error) {
    telegramRuntime.lastError = error.message;
    return null;
  }
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

async function sendDailyClosingReport() {
  const dateKey = previousDailyDateKey();
  const snapshot = dailySnapshots[dateKey] || await refreshDailySnapshot();
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
  const sources = await listMoonSources(60000);
  const live = cache?.payload?.bozokLive || {};
  const report = state?.latestReport || {};
  const formula = kasaFormula(state);
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
    state?.dayClosed ? `Kapanış: <b>${clean(state.dayClosed.businessDate || "-")}</b>` : "Kapanış: açık"
  ].join("\n");
}

function helpText() {
  return [
    "Komutlar:",
    "/menu - butonlu komut merkezi",
    "/anlik - paneldeki anlık kasa formülü",
    "/atlas - Atlas kasa tutarı",
    "/ecem - Ecem kasa tutarı",
    "/aslan - Aslan kasa tutarı",
    "/ares - Ares kasa tutarı",
    "/gider - anlık gider açıklaması",
    "/durum - sistem, veri yaşı ve cihaz bilgisi",
    "/kasa - canlı Moon anlık raporu",
    "/gunsonu - ilk departman anlık panel bakiyesi",
    "/gunsonu Şimşek - seçilen departman anlık panel bakiyesi",
    "/departmanlar - departman listesi",
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
  const command = commandRaw.split("@")[0].toLocaleLowerCase("tr-TR");
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
    await sendMessage(chatId, `Hata: ${clean(error.message)}`);
  }
}

async function dispatchCommand(chatId, command, query = "") {
  if (["/start", "/help", "/yardim", "/yardım"].includes(command)) {
    await sendMessage(chatId, helpText());
    return;
  }

  if (["/menu", "/menü", "/komut"].includes(command)) {
    await sendMainMenu(chatId);
    return;
  }

  if (command === "/anlik") {
    const state = await readDashboardState();
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
    const state = await readDashboardState();
    await sendMessage(chatId, giderReport(state));
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

async function handleTelegramUpdate(update) {
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

  const command = `/${data.slice(4)}`;
  telegramRuntime.lastUpdateAt = new Date().toISOString();
  telegramRuntime.lastCommand = command;
  telegramRuntime.lastChatType = callbackQuery.message?.chat?.type || "";
  telegramRuntime.lastError = "";
  rememberTelegramChat(callbackQuery.message?.chat || {}).catch(error => {
    telegramRuntime.lastError = error.message;
  });

  try {
    await answerCallbackQuery(callbackQuery.id, "Hazırlanıyor");
    await dispatchCommand(chatId, command);
  } catch (error) {
    telegramRuntime.lastError = error.message;
    await answerCallbackQuery(callbackQuery.id, "Hata oluştu").catch(() => {});
    await sendMessage(chatId, `Hata: ${clean(error.message)}`);
  }
}

function telegramStatus() {
  return {
    hasToken: Boolean(token),
    startedAt: telegramRuntime.startedAt,
    lastUpdateAt: telegramRuntime.lastUpdateAt,
    lastCommand: telegramRuntime.lastCommand,
    lastChatType: telegramRuntime.lastChatType,
    lastError: telegramRuntime.lastError,
    dailyScheduler: telegramRuntime.dailyScheduler,
    lastDailySnapshotAt: telegramRuntime.lastDailySnapshotAt,
    lastDailySentDate: telegramRuntime.lastDailySentDate
  };
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

  await telegram("setWebhook", {
    url: `${baseUrl}/api/telegram-webhook`,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  startDailyReportScheduler();
  console.log(`Telegram webhook aktif: ${baseUrl}/api/telegram-webhook`);
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

module.exports = { configureWebhook, handleTelegramUpdate, startTelegramBot, telegramStatus };
