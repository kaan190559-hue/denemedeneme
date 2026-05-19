const fs = require("node:fs");
const path = require("node:path");

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

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN .env içinde yok.");
  process.exit(1);
}

const telegramBase = `https://api.telegram.org/bot${token}`;
const moonUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";

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
  const cookie = cookieHeader();
  if (!cookie) {
    throw new Error("Moon cookie/session yok. .env içine MOON_COOKIE_HEADER veya MOON_SESSION_ID + MOON_CSRF_TOKEN koy.");
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

function trMoney(value, fraction = 2) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction
  }).format(Number(value) || 0);
}

function clean(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
    "📋 <b>GÜN SONU RAPORU</b>",
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
    "/anlik - anlık kasa/yatırım/çekim özeti",
    "/gunsonu - ilk departman gün sonu raporu",
    "/gunsonu Şimşek - seçilen departman raporu",
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

async function poll() {
  let offset = 0;
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

poll();
