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
  writeMoonCache
} = require("./storage");
const { createDefaultDashboardState } = require("./default-state");
const { configureWebhook, handleTelegramUpdate, startTelegramBot } = require("./telegram-bot");
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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function moneyNumber(value) {
  return Number(value) || 0;
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
  return {
    department: selected.departmentName || selected.name || "-",
    date: String(daily.date || new Date().toISOString()).slice(0, 10),
    sourceTimestamp: payload?.timestamp || "",
    sourceUpdatedAt: selected.updatedAt || "",
    devir: moneyNumber(daily.openingBalance),
    yatirim: moneyNumber(daily.depositAmount ?? daily.totalDepositAmount),
    cekim: moneyNumber(daily.withdrawalAmount),
    komisyon: moneyNumber(daily.totalCommission),
    kasa: moneyNumber(daily.closingBalance ?? selected.kasaBalance)
  };
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
  const stored = await writeMoonCache(payload);
  const record = {
    updatedAt: new Date().toISOString(),
    payload
  };
  fs.writeFileSync(cachePath, JSON.stringify(record, null, 2));
  return stored.updatedAt || record.updatedAt;
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

  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
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
    try {
      const record = await readCachedRecord();
      cacheUpdatedAt = record?.updatedAt || "";
      hasCache = Boolean(record?.payload);
    } catch {}
    json(res, 200, {
      ok: true,
      hasCache,
      cacheUpdatedAt,
      hasDatabase: Boolean(process.env.DATABASE_URL),
      cachePath
    });
    return;
  }

  if (requestUrl.pathname === "/api/moon-cache" && req.method === "POST") {
    try {
      const payload = JSON.parse(await readBody(req));
      const updatedAt = await writeCachedPayload(payload);
      json(res, 200, { success: true, updatedAt });
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
      const state = await readDashboardState() || createDefaultDashboardState();
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
      json(res, 200, { success: true, history: await listHistory(limit) });
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
  if (process.env.TELEGRAM_BOT_TOKEN) {
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
