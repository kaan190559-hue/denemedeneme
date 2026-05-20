const fs = require("node:fs");
const path = require("node:path");
const { readDashboardState: readStoredDashboardState } = require("./storage");
const { createDefaultDashboardState } = require("./default-state");

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

const token = process.env.TELEGRAM_BOT_TOKEN;
const moonCookie = process.env.MOON_COOKIE_HEADER;
const moonSession = process.env.MOON_SESSION_ID;
const moonCsrf = process.env.MOON_CSRF_TOKEN;

const telegramBase = `https://api.telegram.org/bot${token}`;
const moonUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
const cachePath = path.join(__dirname, "moon-cache.json");
const dashboardStatePath = path.join(__dirname, "dashboard-state.json");
const dashboardStateUrl = process.env.DASHBOARD_STATE_URL || process.env.RENDER_DASHBOARD_URL || "";

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

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
}

async function fetchMoonDepartments() {
  const cachedDepartments = readCachedDepartments();
  if (cachedDepartments.length) return cachedDepartments;

  const cookie = cookieHeader();
  if (!cookie) {
    throw new Error("Moon cache yok. Edge'de Moon açıkken userscript köprüsü veriyi localhost'a aktarmalı.");
  }

  const response = await fetch(moonUrl, {
    headers: {
      "Accept": "application/json",
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

function readCachedDepartments() {
  try {
    if (!fs.existsSync(cachePath)) return [];
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return cached?.payload?.data?.departments || cached?.payload?.departments || [];
  } catch {
    return [];
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

  return createDefaultDashboardState();
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

function helpText() {
  return [
    "Komutlar:",
    "/anlik - paneldeki anlık kasa formülü",
    "/atlas - Atlas kasa tutarı",
    "/ecem - Ecem kasa tutarı",
    "/aslan - Aslan kasa tutarı",
    "/ares - Ares kasa tutarı",
    "/gider - anlık gider açıklaması",
    "/kasa - canlı Moon anlık raporu",
    "/gunsonu - ilk departman anlık panel bakiyesi",
    "/gunsonu Şimşek - seçilen departman anlık panel bakiyesi",
    "/departmanlar - departman listesi"
  ].join("\n");
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  if (!chatId || !text.startsWith("/")) return;

  const [commandRaw, ...rest] = text.split(/\s+/);
  const command = commandRaw.split("@")[0].toLocaleLowerCase("tr-TR");
  const query = rest.join(" ").trim();

  try {
    if (command === "/start" || command === "/help") {
      await sendMessage(chatId, helpText());
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

    await sendMessage(chatId, helpText());
  } catch (error) {
    await sendMessage(chatId, `Hata: ${clean(error.message)}`);
  }
}

async function handleTelegramUpdate(update) {
  await handleMessage(update?.message || {});
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
    allowed_updates: ["message"],
    drop_pending_updates: false
  });
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

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"]
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleMessage(update.message || {});
      }
    } catch (error) {
      console.error(error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

function startTelegramBot() {
  return poll();
}

if (require.main === module) {
  startTelegramBot();
}

module.exports = { configureWebhook, handleTelegramUpdate, startTelegramBot };
