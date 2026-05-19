const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const envPath = path.join(root, ".env");

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    devir: moneyNumber(daily.openingBalance),
    yatirim: moneyNumber(daily.depositAmount ?? daily.totalDepositAmount),
    cekim: moneyNumber(daily.withdrawalAmount),
    komisyon: moneyNumber(daily.totalCommission),
    kasa: moneyNumber(daily.closingBalance ?? selected.kasaBalance)
  };
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, "http://localhost");

  if (requestUrl.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (requestUrl.pathname === "/api/end-day") {
    try {
      const department = requestUrl.searchParams.get("department") || "";
      const moonUrl = new URL("https://moon-api.aypay.co/v1/departments/with-balances");
      moonUrl.searchParams.set("page", "1");
      moonUrl.searchParams.set("limit", "500");
      const payload = await fetchEndDay(moonUrl);
      json(res, 200, normalizeReport(payload, department));
    } catch (error) {
      json(res, 500, { success: false, error: error.message });
    }
    return;
  }

  serveStatic(req, res);
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Bozok proxy hazır: http://localhost:${port}`);
});
