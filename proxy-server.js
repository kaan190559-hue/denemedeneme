const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const envPath = path.join(root, ".env");
const cachePath = path.join(root, "moon-cache.json");
const {
  readDashboardState,
  writeDashboardState,
  listHistory,
  closeDay,
  listClosures,
  initStorage,
  readMoonCache,
  writeMoonCache,
  listMoonSources
} = require("./storage");
const { configureWebhook, handleTelegramUpdate, startTelegramBot, telegramStatus } = require("./telegram-bot");
const { excelStatus, syncDashboardStateToExcel, syncMoonCacheToExcel } = require("./excel-center");
const { centerStatus, syncDashboardStateToOneDrive, syncMoonCacheToOneDrive } = require("./onedrive-center");
let moonRefresh = {
  id: "",
  status: "idle",
  requestedAt: "",
  completedAt: "",
  error: ""
};

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function csvResponse(res, status, filename, rows) {
  const text = `\ufeff${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
  res.writeHead(status, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(text);
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\r\n;]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function moneyNumber(value) {
  return Number(value) || 0;
}

function numeric(value) {
  if (typeof value === "number") return value;
  const cleaned = String(value ?? "")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  return Number(cleaned) || 0;
}

function thousandFloor(value) {
  const amount = Math.floor(Number(value) || 0);
  return amount >= 1000 ? Math.floor(amount / 1000) * 1000 : 0;
}

function transactionItems(payload, key) {
  const source = payload?.bozokLive?.transactions?.[key];
  if (Array.isArray(source)) return source;
  return source?.data?.transactions || source?.transactions || source?.data || [];
}

function transactionAmount(item) {
  return moneyNumber(
    item.amount
    ?? item.requestAmount
    ?? item.requestedAmount
    ?? item.approvedAmount
    ?? item.totalAmount
    ?? item.price
    ?? item.value
  );
}

function transactionDate(item) {
  return String(
    item.createdAt
    || item.updatedAt
    || item.requestDate
    || item.created_at
    || item.date
    || ""
  ).slice(0, 10);
}

function liveTransactionTotal(payload, key, reportDate) {
  const items = transactionItems(payload, key);
  if (!items.length) return null;
  const datedItems = reportDate ? items.filter(item => !transactionDate(item) || transactionDate(item) === reportDate) : items;
  if (!datedItems.length) return null;
  return datedItems.reduce((sum, item) => sum + transactionAmount(item), 0);
}

function firstLiveTotal(payload, keys, reportDate) {
  for (const key of keys) {
    const total = liveTransactionTotal(payload, key, reportDate);
    if (total !== null) return total;
  }
  return null;
}

function moonPayloadClock(payload) {
  const seq = Number(payload?.bozokLive?.seq || 0);
  const capturedAt = Date.parse(payload?.bozokLive?.capturedAt || "") || 0;
  const sourceTimestamp = Number(payload?.timestamp || 0);
  return Math.max(seq, capturedAt, sourceTimestamp);
}

function recordUpdatedAtMs(record) {
  const time = new Date(record?.updatedAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldKeepCurrentMoonRecord(current, incoming) {
  if (!current?.payload) return false;
  const currentClock = moonPayloadClock(current.payload);
  const incomingClock = moonPayloadClock(incoming);
  const currentAgeMs = Date.now() - recordUpdatedAtMs(current);
  const currentIsFresh = currentAgeMs >= 0 && currentAgeMs < 15000;
  return currentClock > incomingClock && currentIsFresh;
}

function normalizeReport(payload, preferredDepartment) {
  const departments = payload?.data?.departments || payload?.departments || [];
  const selected = departments.find(item => {
    const name = item.departmentName || item.name || "";
    return preferredDepartment ? name.toLocaleLowerCase("tr-TR").includes(preferredDepartment.toLocaleLowerCase("tr-TR")) : true;
  }) || departments[0];

  if (!selected) {
    throw new Error("Moon API departman verisi döndürmedi.");
  }

  const daily = selected.balances?.dailyBalance || {};
  const date = String(daily.date || new Date().toISOString()).slice(0, 10);
  const liveDepositTotal = firstLiveTotal(payload, ["deposits", "activeDeposits"], date);
  const liveWithdrawalTotal = firstLiveTotal(payload, ["withdrawals", "activeWithdrawals"], date);
  return {
    department: selected.departmentName || selected.name || "-",
    date,
    sourceTimestamp: payload?.timestamp || "",
    sourceUpdatedAt: selected.updatedAt || "",
    liveCapturedAt: payload?.bozokLive?.capturedAt || "",
    liveSeq: payload?.bozokLive?.seq || "",
    liveDeviceName: payload?.bozokLive?.deviceName || "",
    devir: moneyNumber(daily.openingBalance),
    yatirim: liveDepositTotal ?? moneyNumber(daily.depositAmount ?? daily.totalDepositAmount),
    cekim: liveWithdrawalTotal ?? moneyNumber(daily.withdrawalAmount),
    komisyon: moneyNumber(daily.totalCommission),
    kasa: moneyNumber(daily.closingBalance ?? selected.kasaBalance)
  };
}

function excelReportRows(payload) {
  const departments = payload?.data?.departments || payload?.departments || [];
  const selected = departments[0];
  if (!selected) {
    return [["departman", "tarih", "devir", "yatirim", "cekim", "yatirim_kom", "kasa", "kaynak", "son_guncelleme"]];
  }
  const daily = selected.balances?.dailyBalance || {};
  const date = String(daily.date || selected.updatedAt || new Date().toISOString()).slice(0, 10);
  const liveDepositTotal = firstLiveTotal(payload, ["deposits", "activeDeposits"], date);
  const liveWithdrawalTotal = firstLiveTotal(payload, ["withdrawals", "activeWithdrawals"], date);
  return [
    ["departman", "tarih", "devir", "yatirim", "cekim", "yatirim_kom", "kasa", "kaynak", "son_guncelleme"],
    [
      selected.departmentName || selected.name || "",
      date,
      thousandFloor(daily.openingBalance),
      thousandFloor(liveDepositTotal ?? daily.depositAmount ?? daily.totalDepositAmount),
      thousandFloor(liveWithdrawalTotal ?? daily.withdrawalAmount),
      thousandFloor(daily.totalCommission),
      thousandFloor(daily.closingBalance ?? selected.kasaBalance),
      payload?.bozokLive?.deviceName || "",
      new Date().toISOString()
    ]
  ];
}

function excelVaultRows(state) {
  const rows = [["kasa", "kasa_adi", "set", "banka", "bakiye", "toplama_giren", "arkaplan", "stil"]];
  for (const [vaultKey, vault] of Object.entries(state?.vaults || {})) {
    for (const [owner, accounts] of Object.entries(vault.sets || {})) {
      for (const account of accounts || []) {
        const amount = numeric(account[1]);
        rows.push([
          vaultKey,
          vault.title || "",
          owner,
          account[0] || "",
          amount,
          thousandFloor(amount),
          vault.bgColor || "",
          state?.vaultStyle || ""
        ]);
      }
    }
  }
  return rows;
}

function excelReconciliationRows(state) {
  return [
    ["aciklama", "grup", "gelir", "kasa", "devir_kom_giderler", "otomatik"],
    ...(state?.reconciliationRows || []).map(row => [
      row.label || "",
      row.group || "",
      numeric(row.gelir),
      numeric(row.kasa),
      numeric(row.devir),
      row.auto ? JSON.stringify(row.auto) : ""
    ])
  ];
}

function excelBlockRows(state) {
  return [
    ["aciklama", "tutar", "not"],
    ...(state?.blockRows || []).map(row => [
      row.name || "",
      numeric(row.amount),
      row.note || ""
    ])
  ];
}

async function readCachedRecord() {
  const stored = await readMoonCache();
  if (stored?.payload) return stored;
  if (!fs.existsSync(cachePath)) return null;
  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  return cached?.payload ? cached : null;
}

async function readCachedPayload() {
  const record = await readCachedRecord();
  return record?.payload || null;
}

async function writeCachedPayload(payload) {
  const current = await readCachedRecord();
  if (shouldKeepCurrentMoonRecord(current, payload)) {
    return {
      updatedAt: current.updatedAt,
      accepted: false,
      skipped: true,
      reason: "current-cache-is-newer",
      currentDeviceName: current.payload?.bozokLive?.deviceName || "",
      incomingDeviceName: payload?.bozokLive?.deviceName || ""
    };
  }
  const stored = await writeMoonCache(payload);
  if (stored.skipped) {
    return {
      updatedAt: stored.updatedAt,
      accepted: false,
      skipped: true,
      reason: stored.reason || "storage-skipped",
      currentDeviceName: stored.currentDeviceName || "",
      incomingDeviceName: stored.incomingDeviceName || payload?.bozokLive?.deviceName || ""
    };
  }
  const record = {
    updatedAt: new Date().toISOString(),
    payload
  };
  fs.writeFileSync(cachePath, JSON.stringify(record, null, 2));
  return {
    updatedAt: stored.updatedAt || record.updatedAt,
    accepted: true,
    skipped: false,
    deviceName: payload?.bozokLive?.deviceName || "",
    capturedAt: payload?.bozokLive?.capturedAt || "",
    seq: payload?.bozokLive?.seq || ""
  };
}

function requestMoonRefresh() {
  moonRefresh = {
    id: String(Date.now()),
    status: "pending",
    requestedAt: new Date().toISOString(),
    completedAt: "",
    error: ""
  };
  return moonRefresh;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("Payload çok büyük."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function fetchEndDay(url) {
  const sessionId = process.env.MOON_SESSION_ID;
  const csrfToken = process.env.MOON_CSRF_TOKEN;
  const cookieHeader = process.env.MOON_COOKIE_HEADER;

  if (!cookieHeader && (!sessionId || !csrfToken)) {
    throw new Error(".env içinde MOON_COOKIE_HEADER veya MOON_SESSION_ID + MOON_CSRF_TOKEN gerekli.");
  }

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Origin": "https://moon.aypay.co",
      "Referer": "https://moon.aypay.co/",
      "Cookie": cookieHeader || `session_id=${sessionId}; csrf_token=${csrfToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Moon API ${response.status} döndürdü.`);
  }

  return response.json();
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };

  const headers = {
    "Content-Type": types[ext] || "application/octet-stream"
  };
  if ([".html", ".js", ".css"].includes(ext)) {
    headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
    headers["Pragma"] = "no-cache";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

loadEnv();

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");

  if (requestUrl.pathname === "/api/health") {
    let cacheUpdatedAt = "";
    let hasCache = false;
    let payloadCapturedAt = "";
    let payloadSeq = "";
    let payloadDeviceName = "";
    let activeSources = [];
    try {
      const record = await readCachedRecord();
      cacheUpdatedAt = record?.updatedAt || "";
      hasCache = Boolean(record?.payload);
      payloadCapturedAt = record?.payload?.bozokLive?.capturedAt || "";
      payloadSeq = record?.payload?.bozokLive?.seq || "";
      payloadDeviceName = record?.payload?.bozokLive?.deviceName || "";
      activeSources = await listMoonSources(60000);
    } catch {}
    json(res, 200, {
      ok: true,
      serverNow: new Date().toISOString(),
      hasCache,
      cacheUpdatedAt,
      payloadCapturedAt,
      payloadSeq,
      payloadDeviceName,
      payloadAgeMs: payloadCapturedAt ? Date.now() - Date.parse(payloadCapturedAt) : null,
      activeSources,
      hasDatabase: Boolean(process.env.DATABASE_URL),
      excel: excelStatus(),
      oneDrive: centerStatus(),
      cachePath
    });
    return;
  }

  if (requestUrl.pathname === "/api/onedrive-status" && req.method === "GET") {
    json(res, 200, { success: true, oneDrive: centerStatus() });
    return;
  }

  if (requestUrl.pathname === "/api/onedrive-sync" && req.method === "POST") {
    try {
      const state = await readDashboardState();
      const record = await readCachedRecord();
      const result = {
        dashboard: state ? await syncDashboardStateToOneDrive(state, { force: true }) : { skipped: true, reason: "dashboard-empty" },
        moon: record?.payload ? await syncMoonCacheToOneDrive(record.payload, { force: true }) : { skipped: true, reason: "moon-cache-empty" }
      };
      json(res, 200, { success: true, oneDrive: centerStatus(), result });
    } catch (error) {
      json(res, 500, { success: false, error: error.message, oneDrive: centerStatus() });
    }
    return;
  }

  if (requestUrl.pathname === "/api/excel-status" && req.method === "GET") {
    json(res, 200, { success: true, excel: excelStatus() });
    return;
  }

  if (requestUrl.pathname === "/api/excel-sync" && req.method === "POST") {
    try {
      const state = await readDashboardState();
      const record = await readCachedRecord();
      const result = {
        dashboard: state ? await syncDashboardStateToExcel(state, { force: true }) : { skipped: true, reason: "dashboard-empty" },
        moon: record?.payload ? await syncMoonCacheToExcel(record.payload, { force: true }) : { skipped: true, reason: "moon-cache-empty" }
      };
      json(res, 200, { success: true, excel: excelStatus(), result });
    } catch (error) {
      json(res, 500, { success: false, error: error.message, excel: excelStatus() });
    }
    return;
  }

  if (requestUrl.pathname.startsWith("/api/excel/") && req.method === "GET") {
    try {
      const file = requestUrl.pathname.split("/").pop();
      if (file === "bozok-live.csv" || file === "live.csv") {
        const payload = await readCachedPayload();
        if (!payload) throw new Error("Render Moon cache boş. Aktif Moon köprüsü veriyi Render'a göndermeli.");
        csvResponse(res, 200, "bozok-live.csv", excelReportRows(payload));
        return;
      }

      const state = await readDashboardState();
      if (!state) throw new Error("Dashboard ortak kaydı yok.");
      if (file === "kasalar.csv") {
        csvResponse(res, 200, "kasalar.csv", excelVaultRows(state));
        return;
      }
      if (file === "formul.csv") {
        csvResponse(res, 200, "formul.csv", excelReconciliationRows(state));
        return;
      }
      if (file === "blokeler.csv") {
        csvResponse(res, 200, "blokeler.csv", excelBlockRows(state));
        return;
      }
      json(res, 404, { success: false, error: "Excel endpoint bulunamadı." });
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/moon-sources" && req.method === "GET") {
    try {
      const activeMs = Number(requestUrl.searchParams.get("activeMs") || 60000);
      json(res, 200, { success: true, sources: await listMoonSources(activeMs) });
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/telegram-status" && req.method === "GET") {
    json(res, 200, { success: true, telegram: telegramStatus() });
    return;
  }

  if (requestUrl.pathname === "/api/moon-cache" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      const result = await writeCachedPayload(payload);
      json(res, 200, { success: true, ...result });
    } catch (error) {
      json(res, 400, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/moon-cache" && req.method === "GET") {
    try {
      const payload = await readCachedPayload();
      if (!payload) throw new Error("Henüz cache yok. Moon sayfasındaki köprü çalışmalı.");
      json(res, 200, payload);
    } catch (error) {
      json(res, 404, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/telegram-webhook" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      await handleTelegramUpdate(payload);
      json(res, 200, { success: true });
    } catch (error) {
      console.error(`Telegram webhook hatası: ${error.message}`);
      json(res, 200, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/dashboard-state" && req.method === "GET") {
    try {
      const state = await readDashboardState();
      if (!state) throw new Error("Dashboard ortak kaydı yok.");
      json(res, 200, { success: true, state });
    } catch (error) {
      json(res, 404, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/dashboard-state" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      const state = await writeDashboardState(payload);
      json(res, 200, { success: true, state });
    } catch (error) {
      json(res, 400, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/change-history" && req.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") || 50);
      const includeState = requestUrl.searchParams.get("includeState") === "1";
      json(res, 200, { success: true, history: await listHistory(limit, includeState) });
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/day-closures" && req.method === "GET") {
    try {
      const limit = Number(requestUrl.searchParams.get("limit") || 30);
      json(res, 200, { success: true, closures: await listClosures(limit) });
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/day-close" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      json(res, 200, { success: true, closure: await closeDay(payload) });
    } catch (error) {
      json(res, 400, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/moon-refresh" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      if (payload.status === "completed" || payload.status === "failed") {
        moonRefresh = {
          ...moonRefresh,
          status: payload.status,
          completedAt: new Date().toISOString(),
          error: payload.error || ""
        };
        json(res, 200, { success: true, refresh: moonRefresh });
        return;
      }
      json(res, 200, { success: true, refresh: requestMoonRefresh() });
    } catch (error) {
      json(res, 400, { success: false, error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/moon-refresh" && req.method === "GET") {
    json(res, 200, { success: true, refresh: moonRefresh });
    return;
  }

  if (requestUrl.pathname === "/api/end-day") {
    try {
      const department = requestUrl.searchParams.get("department") || "";
      let payload = await readCachedPayload();
      if (!payload) {
        const moonUrl = new URL("https://moon-api.aypay.co/v1/departments/with-balances");
        moonUrl.searchParams.set("page", "1");
        moonUrl.searchParams.set("limit", "500");
        payload = await fetchEndDay(moonUrl);
      }
      json(res, 200, normalizeReport(payload, department));
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  serveStatic(req, res);
});

const port = Number(process.env.PORT || 8787);
initStorage().catch(error => console.error(`Storage hazırlanamadı: ${error.message}`));
server.listen(port, () => {
  console.log(`Bozok proxy hazır: http://localhost:${port}`);
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.BOZOK_DISABLE_TELEGRAM !== "1") {
    const publicUrl = process.env.BOZOK_PUBLIC_URL
      || process.env.RENDER_EXTERNAL_URL
      || "https://bozok-financial-dashboard.onrender.com";
    if (process.env.TELEGRAM_USE_POLLING === "1") {
      startTelegramBot().catch(error => console.error(`Telegram bot durdu: ${error.message}`));
    } else {
      configureWebhook(publicUrl).catch(error => console.error(`Telegram webhook ayarlanamadı: ${error.message}`));
    }
  }
});
