const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".playwright-browsers");
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const envPath = path.join(root, ".env");
const moonApiUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
const moonLoginUrl = "https://moon.aypay.co/login";
const moonHomeUrl = "https://moon.aypay.co/departments";

const status = {
  enabled: false,
  running: false,
  source: "playwright",
  lastLoginAt: "",
  lastFetchAt: "",
  lastPushAt: "",
  lastPayloadCapturedAt: "",
  lastError: "",
  seq: 0,
  deviceName: "",
  nextRunAt: "",
  browser: ""
};

let singleton = null;

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

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on", "evet"].includes(value);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findBrowserExecutable() {
  const configured = process.env.MOON_BROWSER_EXECUTABLE;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find(filePath => fs.existsSync(filePath)) || "";
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  const bytes = [];

  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }

  return Buffer.from(bytes);
}

function totpOptions() {
  const algorithm = String(process.env.MOON_TOTP_ALGORITHM || "sha1").toLowerCase();
  return {
    algorithm: ["sha1", "sha256", "sha512"].includes(algorithm) ? algorithm : "sha1",
    stepSeconds: numberEnv("MOON_TOTP_STEP_SECONDS", 30),
    digits: numberEnv("MOON_TOTP_DIGITS", 6)
  };
}

function generateTotp(secret, now = Date.now(), stepSeconds = 30, digits = 6, algorithm = "sha1") {
  const key = base32Decode(secret);
  if (!key.length) throw new Error("MOON_TOTP_SECRET boş veya geçersiz.");
  const counter = BigInt(Math.floor(now / 1000 / stepSeconds));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac(algorithm, key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

async function clickLikelySubmit(page) {
  const candidates = [
    page.getByRole("button", { name: /giriş|giris|login|devam|doğrula|dogrula|verify|onay/i }).first(),
    page.locator("button").filter({ hasText: /giriş|giris|login|devam|doğrula|dogrula|verify|onay/i }).first(),
    page.locator('button[type="submit"]').first()
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  await page.keyboard.press("Enter").catch(() => {});
  return false;
}

async function visible(locator, timeout = 1000) {
  try {
    return await locator.isVisible({ timeout });
  } catch {
    return false;
  }
}

async function waitVisible(locator, timeout = 10000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

class MoonAutomation {
  constructor(options = {}) {
    this.onPayload = options.onPayload || null;
    this.context = null;
    this.page = null;
    this.timer = null;
    this.busy = false;
    this.loginAttempts = 0;
    this.intervalMs = Math.max(1000, numberEnv("MOON_AUTOMATION_INTERVAL_MS", 1000));
    this.fetchTimeoutMs = numberEnv("MOON_FETCH_TIMEOUT_MS", 10000);
    this.userDataDir = process.env.MOON_AUTH_DIR || path.join(root, "moon-auth-storage");
    this.totpSecretPath = path.join(this.userDataDir, "moon-totp-secret.txt");
    this.deviceName = process.env.MOON_DEVICE_NAME || `${os.hostname()}-moon-bot`;
    status.deviceName = this.deviceName;
  }

  async start() {
    status.enabled = true;
    status.running = true;
    this.schedule(0);
    return this;
  }

  async stop() {
    status.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  schedule(ms = this.intervalMs) {
    if (!status.running) return;
    clearTimeout(this.timer);
    status.nextRunAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => {
      this.runLoop().catch(error => {
        status.lastError = error.message;
        this.schedule(this.intervalMs);
      });
    }, ms);
  }

  async runLoop() {
    if (this.busy) {
      this.schedule(250);
      return;
    }
    this.busy = true;
    try {
      await this.runOnce();
      status.lastError = "";
    } catch (error) {
      status.lastError = error.message;
      if (/401|403|yetki|login|oturum|auth/i.test(error.message)) {
        await this.resetSession();
      }
    } finally {
      this.busy = false;
      this.schedule(this.intervalMs);
    }
  }

  async ensureContext() {
    if (this.context && this.page) return;
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const executablePath = findBrowserExecutable();
    const launchOptions = {
      headless: boolEnv("MOON_HEADLESS", true),
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
      timeout: numberEnv("MOON_BROWSER_LAUNCH_TIMEOUT_MS", 45000),
      viewport: { width: 1440, height: 900 }
    };
    if (executablePath) {
      launchOptions.executablePath = executablePath;
      status.browser = executablePath;
    } else {
      status.browser = "playwright-managed";
    }

    this.context = await chromium.launchPersistentContext(this.userDataDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(numberEnv("MOON_PAGE_TIMEOUT_MS", 30000));
  }

  async resetSession() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async cookieHeader() {
    await this.ensureContext();
    const cookies = await this.context.cookies(["https://moon.aypay.co", "https://moon-api.aypay.co"]);
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async fetchMoonPayload() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(moonApiUrl, {
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Origin": "https://moon.aypay.co",
          "Referer": "https://moon.aypay.co/",
          "User-Agent": "Mozilla/5.0",
          "Cookie": await this.cookieHeader()
        }
      });
      if (!response.ok) throw new Error(`Moon API ${response.status}`);
      const payload = await response.json();
      if (!payload?.success && !payload?.data?.departments) throw new Error("Moon API beklenen departman verisini döndürmedi.");
      status.lastFetchAt = new Date().toISOString();
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureLoggedIn() {
    try {
      return await this.fetchMoonPayload();
    } catch {
      // Fall through to normal browser login.
    }

    const username = process.env.MOON_USERNAME;
    const password = process.env.MOON_PASSWORD;
    const totpSecret = process.env.MOON_TOTP_SECRET;
    if (!username || !password || !totpSecret) {
      throw new Error("MOON_USERNAME, MOON_PASSWORD ve MOON_TOTP_SECRET gerekli.");
    }

    await this.ensureContext();
    this.loginAttempts += 1;
    await this.page.goto(moonLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const usernameInput = this.page.locator('#username, input[name="username"], input[autocomplete="username"]').first();
    const passwordInput = this.page.locator('#password, input[name="password"], input[type="password"]').first();
    if (await visible(usernameInput, 5000)) {
      await usernameInput.fill(username);
      await passwordInput.fill(password);
      await clickLikelySubmit(this.page);
    }

    await this.fillTotpIfNeeded();
    await this.waitForMoonSession();
    await this.page.goto(moonHomeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const payload = await this.fetchMoonPayload();
    status.lastLoginAt = new Date().toISOString();
    return payload;
  }

  async waitForMoonSession() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const cookies = await this.context.cookies(["https://moon.aypay.co", "https://moon-api.aypay.co"]);
      if (cookies.some(cookie => cookie.name === "session_id")) return true;
      if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 100 }).catch(() => false)) break;
      await delay(500);
    }
    return false;
  }

  async fillTotpIfNeeded() {
    const inputs = this.page.locator('input.code-input, input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (!(await waitVisible(inputs.first(), 10000))) return;

    const secret = await this.resolveTotpSecret();
    await this.typeTotpCode(inputs, secret);
    await clickLikelySubmit(this.page);
    await delay(1600);

    if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false)) {
      await this.waitForFreshTotpWindow();
      await this.typeTotpCode(inputs, secret);
      await clickLikelySubmit(this.page);
      await delay(1600);
    }

    if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false)) {
      if (await this.tryBackupCode()) return;
      throw new Error("Moon 2FA kodu geçersiz. MOON_TOTP_SECRET doğru secret olmalı veya MOON_BACKUP_CODE girilmeli.");
    }
  }

  async waitForFreshTotpWindow() {
    const { stepSeconds } = totpOptions();
    const secondsLeft = stepSeconds - (Math.floor(Date.now() / 1000) % stepSeconds);
    if (secondsLeft <= 10) await delay((secondsLeft + 1) * 1000);
  }

  async typeTotpCode(inputs, secret) {
    await this.waitForFreshTotpWindow();
    const { algorithm, stepSeconds, digits } = totpOptions();
    const code = generateTotp(secret, Date.now(), stepSeconds, digits, algorithm);
    const count = await inputs.count();
    if (count >= 6) {
      for (let index = 0; index < count; index += 1) {
        await inputs.nth(index).fill("").catch(() => {});
      }
      await inputs.first().click();
      await this.page.keyboard.type(code, { delay: 70 });
    } else {
      await inputs.first().fill(code);
    }
  }

  async tryBackupCode() {
    const backupCode = process.env.MOON_BACKUP_CODE || process.env.MOON_2FA_BACKUP_CODE;
    if (!backupCode) return false;

    const backupButton = this.page.getByText(/yedek kod|backup code/i).first();
    if (!(await backupButton.isVisible({ timeout: 1000 }).catch(() => false))) return false;
    await backupButton.click();
    await delay(500);

    const input = this.page.locator('input:not(.code-input), textarea, input.code-input').first();
    if (!(await waitVisible(input, 5000))) return false;
    await input.fill(String(backupCode));
    await clickLikelySubmit(this.page);
    await delay(1600);
    return !(await this.page.getByText(/invalid|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false));
  }

  async resolveTotpSecret() {
    const setupSecret = await this.readSetupTotpSecret();
    if (setupSecret) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this.totpSecretPath, setupSecret, "utf8");
      return setupSecret;
    }

    if (process.env.MOON_TOTP_SECRET) return process.env.MOON_TOTP_SECRET;

    if (fs.existsSync(this.totpSecretPath)) {
      const saved = fs.readFileSync(this.totpSecretPath, "utf8").trim();
      if (saved) return saved;
    }

    return "";
  }

  async readSetupTotpSecret() {
    try {
      const { valueSecrets, textSecrets } = await this.page.evaluate(() => {
        const cleanMatches = raw => {
          const text = String(raw || "").replace(/\s+/g, "");
          return text.match(/[A-Z2-7]{24,}/g) || [];
        };
        return {
          valueSecrets: [...document.querySelectorAll("input, textarea")]
            .flatMap(element => cleanMatches(element.value)),
          textSecrets: [...document.querySelectorAll("code, pre, span, p")]
            .flatMap(element => cleanMatches(element.textContent))
        };
      });
      const inputSecret = [...new Set(valueSecrets)]
        .filter(secret => base32LooksUsable(secret))
        .sort((a, b) => b.length - a.length)[0] || "";
      if (inputSecret) return inputSecret;
      return [...new Set(textSecrets)]
        .filter(secret => base32LooksUsable(secret))
        .sort((a, b) => b.length - a.length)[0] || "";
    } catch {
      return "";
    }
  }

  enrichPayload(payload) {
    const capturedAt = new Date().toISOString();
    const seq = Date.now();
    status.seq = seq;
    status.lastPayloadCapturedAt = capturedAt;
    return {
      ...payload,
      bozokLive: {
        ...(payload.bozokLive || {}),
        capturedAt,
        seq,
        deviceName: this.deviceName,
        source: "playwright",
        transport: "moon-automation"
      }
    };
  }

  async pushPayload(payload) {
    if (this.onPayload) {
      const result = await this.onPayload(payload);
      status.lastPushAt = new Date().toISOString();
      return result;
    }

    const base = process.env.BOZOK_PUBLIC_URL
      || process.env.DASHBOARD_STATE_URL
      || "http://localhost:8787";
    const response = await fetch(new URL("/api/moon-cache", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Bozok cache POST ${response.status}`);
    const result = await response.json();
    status.lastPushAt = new Date().toISOString();
    return result;
  }

  async runOnce() {
    await this.ensureContext();
    const payload = await this.ensureLoggedIn();
    const enriched = this.enrichPayload(payload);
    const pushed = await this.pushPayload(enriched);
    return { payload: enriched, pushed };
  }
}

async function runMoonAutomationOnce(options = {}) {
  loadEnv();
  const worker = new MoonAutomation(options);
  try {
    return await worker.runOnce();
  } finally {
    await worker.stop();
  }
}

async function startMoonAutomation(options = {}) {
  loadEnv();
  if (singleton) return singleton;
  singleton = new MoonAutomation(options);
  await singleton.start();
  return singleton;
}

function moonAutomationStatus() {
  return { ...status };
}

async function cli() {
  loadEnv();
  const mode = process.argv[2] || "once";
  if (mode === "worker") {
    await startMoonAutomation();
    console.log("Moon automation worker çalışıyor.");
    return;
  }
  const result = await runMoonAutomationOnce();
  console.log(JSON.stringify({
    success: true,
    pushed: result.pushed,
    capturedAt: result.payload.bozokLive.capturedAt,
    deviceName: result.payload.bozokLive.deviceName
  }, null, 2));
}

if (require.main === module) {
  cli().catch(error => {
    console.error(`Moon automation hatası: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  generateTotp,
  runMoonAutomationOnce,
  startMoonAutomation,
  moonAutomationStatus
};

function base32LooksUsable(secret) {
  try {
    return base32Decode(secret).length >= 10;
  } catch {
    return false;
  }
}
