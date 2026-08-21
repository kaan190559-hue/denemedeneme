// ==UserScript==
// @name         Bozok Moon Köprüsü
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.6.0
// @description  Açık Moon oturumundan Bozok panele bakiye, kasa ledger ve hesap yatırım listesi aktarır.
// @downloadURL  https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-render-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-render-bridge.user.js
// @author       Bozok
// @match        https://moon.aypay.co/*
// @icon         https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/icon.png
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bozok.bozokfinans.uk
// @connect      *.bozokfinans.uk
// @connect      bozok-financial-dashboard.onrender.com
// @connect      *.onrender.com
// @connect      moon-api.aypay.co
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    RENDER_BASE_URL: "https://bozok.bozokfinans.uk",
    MOON_API: "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500",
    TX_API: "https://moon-api.aypay.co/v1/transactions",
    POLL_MS: 1000,
    LEDGER_MS: 4000,
    WD_REFRESH_MS: 12000,
    FETCH_TIMEOUT_MS: 12000,
    POST_TIMEOUT_MS: 60000,
    DEVICE_KEY: "bozokRenderBridgeDevice",
    RENDER_KEY: "bozokRenderBridgeUrl"
  };

  let pollTimer = 0;
  let ledgerTimer = 0;
  let inFlight = false;
  let postInFlight = false;
  let ledgerInFlight = false;
  let seq = 0;
  let lastLedgerSummary = "";
  let lastWithdrawalAt = 0;
  let lastWithdrawalEvents = [];
  let lastDepositItems = [];
  let lastPartialItems = [];
  const partialCache = new Map();

  function cleanUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getRenderBaseUrl() {
    const saved = cleanUrl(GM_getValue(CONFIG.RENDER_KEY, ""));
    if (!saved || saved.includes("onrender.com")) return CONFIG.RENDER_BASE_URL;
    return saved;
  }

  function getDeviceName() {
    const saved = String(GM_getValue(CONFIG.DEVICE_KEY, "") || "").trim();
    if (saved) return saved;
    const generated = `Render-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    GM_setValue(CONFIG.DEVICE_KEY, generated);
    return generated;
  }

  function moonFetchOptions() {
    return {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      }
    };
  }

  function requestJson(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.body,
        timeout: options.timeout || 15000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          try {
            resolve(response.responseText ? JSON.parse(response.responseText) : {});
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Bağlantı kurulamadı")),
        ontimeout: () => reject(new Error("Zaman aşımı"))
      });
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function pickFirst(...values) {
    return values.find(value => value !== undefined && value !== null && String(value).trim() !== "") || "";
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "")
      .replace(/[^\d,.\-]/g, "")
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeStatus(value) {
    return String(value || "")
      .toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c");
  }

  function isApproved(value) {
    const status = normalizeStatus(value);
    if (!status) return false;
    return /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
      && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);
  }

  function transactionArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
    if (Array.isArray(payload?.transactions)) return payload.transactions;
    if (Array.isArray(payload?.data?.payments)) return payload.data.payments;
    if (Array.isArray(payload?.payments)) return payload.payments;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function txUrl(type, status = "", page = 1, limit = 80) {
    const url = new URL(CONFIG.TX_API);
    url.searchParams.set("type", type);
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  function compactAccount(item = {}) {
    const bankAccount = asObject(item.bankAccount)
      || asObject(item.assignedAccount)
      || asObject(item.paymentAccount)
      || asObject(item.destinationAccount)
      || asObject(item.receiverAccount)
      || asObject(item.accountSnapshot)
      || asObject(item.account)
      || {};
    const bank = String(pickFirst(
      item.bankName,
      typeof item.bank === "string" ? item.bank : "",
      item.bankTitle,
      bankAccount.bankName,
      typeof bankAccount.bank === "string" ? bankAccount.bank : "",
      bankAccount.bankTitle
    )).trim();
    const account = String(pickFirst(
      item.accountName,
      item.accountHolderName,
      item.holderName,
      item.receiverName,
      item.setName,
      item.ownerName,
      typeof item.account === "string" ? item.account : "",
      bankAccount.accountName,
      bankAccount.accountHolderName,
      bankAccount.holderName,
      bankAccount.setName,
      bankAccount.fullName,
      typeof bankAccount.name === "string" ? bankAccount.name : ""
    )).trim();
    const userObj = asObject(item.user) || asObject(item.customer) || asObject(item.member) || {};
    const identifiers = [item._id, item.id, item.transactionId, item.processId, item.paymentId, item.partId]
      .map(value => String(value || "").trim())
      .filter(Boolean);
    return {
      id: identifiers[0] || "",
      amount: parseMoney(pickFirst(
        item.approvedAmount,
        item.confirmedAmount,
        item.finalAmount,
        item.processedAmount,
        item.paidAmount,
        item.amount,
        item.paymentAmount,
        item.transferAmount
      )),
      status: String(pickFirst(item.status, item.state, item.paymentStatus) || ""),
      bank,
      account,
      user: String(pickFirst(
        typeof item.user === "string" ? item.user : "",
        userObj.fullName,
        userObj.name,
        item.userName,
        item.customerName,
        item.fullName,
        item.playerName,
        item.senderName
      )).trim(),
      completedAt: String(pickFirst(item.completedAt, item.approvedAt, item.finishedAt, item.updatedAt, item.assignedAt) || ""),
      date: String(pickFirst(item.createdAt, item.requestDate, item.date, item.completedAt) || "").slice(0, 10)
    };
  }

  function paymentArrays(payload) {
    const found = [];
    const candidates = [
      payload?.partialPayments,
      payload?.payments,
      payload?.parts,
      payload?.data?.partialPayments,
      payload?.data?.payments,
      payload?.data?.parts
    ];
    for (const list of candidates) {
      if (Array.isArray(list) && list.length) found.push(...list);
    }
    if (Array.isArray(payload) && payload.length && payload[0] && typeof payload[0] === "object") {
      found.push(...payload);
    }
    return found;
  }

  async function moonGet(url) {
    const response = await fetchWithTimeout(url, moonFetchOptions(), CONFIG.FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Moon ${response.status}`);
    return response.json();
  }

  async function collectDepositEvents() {
    const urls = [
      txUrl("deposit", "approved", 1, 80),
      txUrl("deposit", "completed", 1, 80),
      txUrl("deposit", "", 1, 80)
    ];
    let items = [];
    for (const url of urls) {
      try {
        const payload = await moonGet(url);
        const list = transactionArray(payload)
          .map(compactAccount)
          .filter(item => {
            if (!item.id || !(item.amount > 0) || !item.bank || !item.account) return false;
            if (item.status) return isApproved(item.status);
            return /[?&]status=(approved|completed)/.test(url);
          });
        if (list.length) {
          items = list;
          lastDepositItems = list;
          break;
        }
      } catch (error) {
        console.warn("[Bozok kasa] yatırım listesi", error);
      }
    }
    return items.map(item => ({
      ledgerKey: `dep:${item.id}`,
      amount: item.amount,
      bank: item.bank,
      account: item.account,
      completedAt: item.completedAt,
      kind: "deposit"
    }));
  }

  async function paymentsForWithdrawal(item) {
    const embedded = paymentArrays(item).map(raw => compactAccount({ ...raw, ...item, ...raw }));
    if (embedded.some(payment => payment.amount > 0 && payment.bank && payment.account)) {
      return embedded;
    }
    const cached = partialCache.get(item.id);
    if (cached && Date.now() - cached.at < CONFIG.WD_REFRESH_MS) return cached.payments;
    let payments = [];
    const urls = [
      `https://moon-api.aypay.co/v1/transactions/${encodeURIComponent(item.id)}/partial-payments`,
      `https://moon-api.aypay.co/v1/transactions/${encodeURIComponent(item.id)}`
    ];
    for (const url of urls) {
      try {
        const payload = await moonGet(url);
        payments = paymentArrays(payload).map(raw => compactAccount({ ...item, ...raw }));
        if (!payments.length) payments = [compactAccount({ ...item, ...payload })];
        if (payments.some(payment => payment.amount > 0 && payment.bank && payment.account)) break;
      } catch (error) {
        console.warn("[Bozok kasa] parçalı ödeme", item.id, error);
      }
    }
    if (partialCache.size > 80) partialCache.clear();
    partialCache.set(item.id, { at: Date.now(), payments });
    return payments;
  }

  async function collectWithdrawalEvents() {
    if (Date.now() - lastWithdrawalAt < CONFIG.WD_REFRESH_MS && lastWithdrawalEvents.length) {
      return lastWithdrawalEvents;
    }
    let list = [];
    try {
      const payload = await moonGet(txUrl("withdrawal", "", 1, 12));
      list = transactionArray(payload).map(compactAccount).filter(item => item.id);
    } catch (error) {
      console.warn("[Bozok kasa] çekim listesi", error);
      return lastWithdrawalEvents;
    }
    const events = [];
    const partials = [];
    for (const item of list.slice(0, 12)) {
      const payments = await paymentsForWithdrawal(item);
      for (const payment of payments) {
        if (payment.status && !isApproved(payment.status)) continue;
        const amount = Math.abs(Number(payment.amount || 0));
        const bank = String(payment.bank || item.bank || "").trim();
        const account = String(payment.account || item.account || "").trim();
        const id = String(payment.id || [item.id, bank, account, Math.round(amount)].filter(Boolean).join(":"));
        if (!id || !(amount > 0) || !bank || !account) continue;
        events.push({
          ledgerKey: `wd:${id}`,
          amount: -amount,
          bank,
          account,
          completedAt: payment.completedAt || item.completedAt || "",
          kind: "withdrawal"
        });
        partials.push({
          id,
          amount,
          bank,
          account,
          status: payment.status || "approved",
          user: payment.user || item.user || "",
          completedAt: payment.completedAt || item.completedAt || ""
        });
      }
    }
    lastWithdrawalAt = Date.now();
    lastWithdrawalEvents = events;
    lastPartialItems = partials;
    return events;
  }

  async function syncLedger() {
    if (ledgerInFlight) return;
    ledgerInFlight = true;
    try {
      const [deposits, withdrawals] = await Promise.all([
        collectDepositEvents(),
        collectWithdrawalEvents()
      ]);
      const events = [...deposits, ...withdrawals];
      if (!events.length) {
        lastLedgerSummary = "işlem yok";
        return;
      }
      const result = await requestJson(`${getRenderBaseUrl()}/api/moon-kasa-ledger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, deviceName: getDeviceName() }),
        timeout: CONFIG.POST_TIMEOUT_MS
      });
      lastLedgerSummary = `kasa +${result.applied || 0} / atlanan ${result.skipped || 0} / eşleşmeyen ${result.unmatched || 0}`;
      if (result.unmatchedSamples?.length) {
        console.warn("[Bozok kasa]", lastLedgerSummary, result.unmatchedSamples);
      } else {
        console.info("[Bozok kasa]", lastLedgerSummary, { deposits: deposits.length, withdrawals: withdrawals.length });
      }
    } catch (error) {
      lastLedgerSummary = String(error.message || "kasa hata").slice(0, 40);
      console.warn("[Bozok kasa]", error);
    } finally {
      ledgerInFlight = false;
    }
  }

  async function fetchMoonPayload() {
    const response = await fetchWithTimeout(CONFIG.MOON_API, moonFetchOptions(), CONFIG.FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Moon ${response.status}`);
    seq += 1;
    return {
      ...(await response.json()),
      bozokLive: {
        capturedAt: new Date().toISOString(),
        deviceName: getDeviceName(),
        mode: "render-bridge",
        seq,
        transactions: {
          deposits: { data: { transactions: lastDepositItems } },
          withdrawalPartials: { payments: lastPartialItems, count: lastPartialItems.length }
        }
      }
    };
  }

  async function pushToRender(payload) {
    const url = `${getRenderBaseUrl()}/api/moon-cache`;
    return requestJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: CONFIG.POST_TIMEOUT_MS
    });
  }

  function setStatus(text, tone = "idle") {
    if (!statusEl) return;
    const colors = { ok: "#14b87a", fail: "#ef4444", idle: "#64748b", busy: "#f59e0b" };
    const icons = { ok: "✓", fail: "!", idle: "•", busy: "…" };
    statusEl.textContent = icons[tone] || icons.idle;
    statusEl.style.background = colors[tone] || colors.idle;
    statusEl.title = `Bozok köprü — ${text}${lastLedgerSummary ? ` | ${lastLedgerSummary}` : ""} (tıkla: ayarlar, çift tık: hemen gönder)`;
  }

  async function syncOnce() {
    if (inFlight || postInFlight) return;
    inFlight = true;
    setStatus("Moon okunuyor…", "busy");
    try {
      const payload = await fetchMoonPayload();
      postInFlight = true;
      setStatus("Render'a gönderiliyor…", "busy");
      const result = await pushToRender(payload);
      if (result.skipped && !result.accepted) {
        setStatus(`Atlandı: ${result.currentDeviceName || "başka cihaz"}`, "idle");
        return;
      }
      const time = new Date(result.updatedAt || Date.now()).toLocaleTimeString("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      setStatus(`OK ${time}`, "ok");
    } catch (error) {
      setStatus(String(error.message || "Hata").slice(0, 28), "fail");
      console.warn("[Bozok Render Köprüsü]", error);
    } finally {
      inFlight = false;
      postInFlight = false;
    }
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(syncOnce, CONFIG.POLL_MS);
    if (ledgerTimer) clearInterval(ledgerTimer);
    ledgerTimer = setInterval(syncLedger, CONFIG.LEDGER_MS);
  }

  function openSettings() {
    const currentUrl = getRenderBaseUrl();
    const currentDevice = getDeviceName();
    const nextUrl = window.prompt("Render URL", currentUrl);
    if (nextUrl === null) return;
    const trimmedUrl = cleanUrl(nextUrl);
    if (trimmedUrl) GM_setValue(CONFIG.RENDER_KEY, trimmedUrl);
    const nextDevice = window.prompt("Cihaz adı (DB'de görünür)", currentDevice);
    if (nextDevice === null) return;
    const trimmedDevice = String(nextDevice || "").trim();
    if (trimmedDevice) GM_setValue(CONFIG.DEVICE_KEY, trimmedDevice);
    setStatus("Ayar kaydedildi", "ok");
    syncOnce();
    syncLedger();
  }

  const statusEl = document.createElement("button");
  statusEl.type = "button";
  statusEl.title = "Bozok Render Köprüsü — tıkla: ayarlar, çift tık: hemen gönder";
  statusEl.textContent = "•";
  statusEl.style.cssText = [
    "position:fixed",
    "right:10px",
    "bottom:10px",
    "z-index:2147483646",
    "width:16px",
    "height:16px",
    "padding:0",
    "border:1px solid rgba(255,255,255,.35)",
    "border-radius:50%",
    "background:#64748b",
    "color:#fff",
    "font:800 10px/16px system-ui,sans-serif",
    "text-align:center",
    "cursor:pointer",
    "box-shadow:0 4px 12px rgba(0,0,0,.28)",
    "opacity:0.85"
  ].join(";");
  statusEl.addEventListener("click", openSettings);
  statusEl.addEventListener("dblclick", event => {
    event.preventDefault();
    syncOnce();
    syncLedger();
  });

  let bgAudioCtx = null;

  function preventBackgroundThrottle() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      bgAudioCtx = new AudioCtx();
      const oscillator = bgAudioCtx.createOscillator();
      const gain = bgAudioCtx.createGain();
      gain.gain.value = 0.0001;
      oscillator.frequency.value = 19000;
      oscillator.connect(gain);
      gain.connect(bgAudioCtx.destination);
      oscillator.start();
    } catch (error) {
      console.warn("[Bozok köprü] arka plan koruması başlatılamadı", error);
    }
  }

  function resumeBackgroundAudio() {
    if (bgAudioCtx && bgAudioCtx.state === "suspended") {
      bgAudioCtx.resume().catch(() => {});
    }
  }

  function start() {
    document.body.appendChild(statusEl);
    setStatus(`Başladı (${CONFIG.POLL_MS / 1000}s)`, "idle");
    preventBackgroundThrottle();
    syncOnce();
    syncLedger();
    schedulePoll();
    document.addEventListener("visibilitychange", () => {
      resumeBackgroundAudio();
      if (!document.hidden) {
        syncOnce();
        syncLedger();
      }
    });
    window.addEventListener("focus", () => {
      resumeBackgroundAudio();
      syncOnce();
      syncLedger();
    });
    document.addEventListener("click", resumeBackgroundAudio, { once: true, capture: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
