const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 10000);
const CAPTURE_TOKEN = String(process.env.TELEGRAM_CAPTURE_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "bozok-capture").trim();
const CAPTURE_BASE = `http://127.0.0.1:${PORT}`;

let browserPromise = null;

function captureToken() {
  return CAPTURE_TOKEN;
}

function captureUrl(mode) {
  const params = new URLSearchParams({
    capture: mode,
    token: CAPTURE_TOKEN
  });
  return `${CAPTURE_BASE}/?${params.toString()}`;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }).catch(error => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function captureSection(mode) {
  const selector = mode === "anlik"
    ? ".reconciliation-section"
    : '[data-vault-card="atlas"]';
  const viewport = mode === "anlik"
    ? { width: 1480, height: 980 }
    : { width: 560, height: 1200 };

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  try {
    await page.goto(captureUrl(mode), {
      waitUntil: "networkidle",
      timeout: 45000
    });
    await page.waitForSelector('[data-capture-ready="1"]', { timeout: 45000 });
    await page.waitForSelector(selector, { timeout: 15000 });
    await page.waitForTimeout(350);
    const element = await page.$(selector);
    if (!element) throw new Error(`Ekran goruntusu alani bulunamadi: ${selector}`);
    return await element.screenshot({ type: "png" });
  } finally {
    await context.close();
  }
}

async function captureAnlikScreenshot() {
  return captureSection("anlik");
}

async function captureAtlasScreenshot() {
  return captureSection("atlas");
}

async function closeCaptureBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close().catch(() => {});
}

module.exports = {
  captureToken,
  captureAnlikScreenshot,
  captureAtlasScreenshot,
  closeCaptureBrowser
};
