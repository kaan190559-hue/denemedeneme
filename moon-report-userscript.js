// ==UserScript==
// @name         Bozok Anlık Panel Bakiye Aktarıcı
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.9.2
// @description  Moon AyPAY canlı verisini aktarır ve son bir saatteki tekrar yatırım taleplerini işaretler.
// @downloadURL  https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/moon-report-userscript.js
// @updateURL    https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/moon-report-userscript.js
// @match        https://moon.aypay.co/*
// @match        https://raw.githack.com/kaan190559-hue/denemedeneme/*
// @match        https://*.onrender.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      localhost
// @connect      127.0.0.1
// @connect      bozok-financial-dashboard.onrender.com
// @connect      *.onrender.com
// @connect      moon-api.aypay.co
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DASHBOARD_URL = "https://raw.githack.com/kaan190559-hue/denemedeneme/main/index.html";
  const API_URL = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
  const LOCAL_CACHE_URL = "http://localhost:8787/api/moon-cache";
  const LOCAL_REFRESH_URL = "http://localhost:8787/api/moon-refresh";
  const LOCAL_REPORT_URL = "http://127.0.0.1:8787/api/end-day";
  const RENDER_URL_KEY = "bozokRenderBaseUrl";
  const LIVE_PAYLOAD_KEY = "bozokLiveMoonPayload";
  const DEVICE_NAME_KEY = "bozokDeviceName";
  const DEFAULT_RENDER_BASE_URL = "https://bozok-financial-dashboard.onrender.com";
  let lastRefreshId = "";
  let cacheInFlight = false;
  let moonBridgeStarted = false;
  let refreshSeq = 0;
  let refreshTimer = 0;
  let inFlightStartedAt = 0;
  let renderPostInFlight = false;
  let localPostInFlight = false;
  let renderPostStartedAt = 0;
  let localPostStartedAt = 0;
  let latestRenderPayload = null;
  let latestLocalPayload = null;
  let depositRiskData = null;
  let depositRiskInFlight = false;
  let depositRiskScanTimer = 0;
  let depositRiskObserver = null;

  function normalizeIdentity(value) {
    return String(value || "")
      .toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/ğ/g, "g")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ö/g, "o")
      .replace(/ç/g, "c")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function installDepositRiskStyles() {
    if (document.getElementById("bozok-deposit-risk-styles")) return;
    const style = document.createElement("style");
    style.id = "bozok-deposit-risk-styles";
    style.textContent = `
      .bozok-risk-row-repeat { box-shadow: inset 4px 0 0 #ef4444 !important; background-image: linear-gradient(90deg, rgba(239,68,68,.12), transparent 35%) !important; }
      .bozok-risk-row-first { box-shadow: inset 4px 0 0 #22c55e !important; background-image: linear-gradient(90deg, rgba(34,197,94,.08), transparent 28%) !important; }
      .bozok-risk-badge { display:inline-flex !important; align-items:center; gap:5px; min-height:22px; margin-left:8px; padding:2px 8px; border:1px solid transparent; border-radius:6px; font:700 11px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif; letter-spacing:0; vertical-align:middle; cursor:pointer; white-space:nowrap; user-select:none; }
      .bozok-risk-badge::before { content:"!"; display:grid; place-items:center; width:15px; height:15px; border-radius:50%; font-size:10px; font-weight:900; }
      .bozok-risk-badge[data-level="repeat"] { color:#fecaca; background:#7f1d1d; border-color:#ef4444; box-shadow:0 0 0 2px rgba(239,68,68,.12); }
      .bozok-risk-badge[data-level="repeat"]::before { color:#7f1d1d; background:#fecaca; }
      .bozok-risk-badge[data-level="first"] { color:#bbf7d0; background:#14532d; border-color:#22c55e; }
      .bozok-risk-badge[data-level="first"]::before { content:"✓"; color:#14532d; background:#bbf7d0; }
      #bozok-risk-popover { position:fixed; z-index:2147483647; width:min(360px,calc(100vw - 24px)); padding:14px; border:1px solid #334155; border-radius:10px; background:#0f172a; color:#e2e8f0; box-shadow:0 20px 60px rgba(0,0,0,.5); font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
      #bozok-risk-popover strong { display:block; margin-bottom:7px; color:#fff; font-size:14px; }
      #bozok-risk-popover .bozok-risk-popover-line { padding:7px 0; border-top:1px solid rgba(148,163,184,.18); }
      #bozok-risk-popover .bozok-risk-popover-meta { color:#94a3b8; font-size:12px; }
    `;
    document.head.appendChild(style);
  }

  function formatRiskMoney(value) {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function escapeRiskHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatRiskTime(value) {
    const parsed = Date.parse(value || "");
    if (!Number.isFinite(parsed)) return "Saat bilinmiyor";
    return new Date(parsed).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function riskValueByKey(source, keys) {
    if (!source || typeof source !== "object") return "";
    const wanted = new Set(keys.map(key => String(key).toLowerCase()));
    const queue = [source];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      for (const [key, value] of Object.entries(current)) {
        if (wanted.has(key.toLowerCase()) && value !== undefined && value !== null && String(value).trim()) return value;
      }
      for (const value of Object.values(current)) {
        if (value && typeof value === "object") queue.push(value);
      }
    }
    return "";
  }

  function riskTransactionArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
    if (Array.isArray(payload?.transactions)) return payload.transactions;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function riskNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const cleaned = String(value || "")
      .replace(/[^\d,.\-]/g, "")
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(",", ".");
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function riskTime(source, keys) {
    for (const key of keys) {
      const value = riskValueByKey(source, [key]);
      const parsed = Date.parse(value || "");
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function compactBrowserRiskTransaction(item = {}) {
    const identifiers = ["_id", "id", "transactionId", "processId", "operationId", "requestId", "uuid"]
      .map(key => riskValueByKey(item, [key]))
      .map(value => String(value || "").trim())
      .filter(Boolean);
    const user = riskValueByKey(item, ["userName", "username", "customerName", "fullName", "name"]);
    return {
      id: identifiers[0] || "",
      identifiers: [...new Set(identifiers)],
      user: String(user || ""),
      status: String(riskValueByKey(item, ["status", "state"]) || ""),
      amount: riskNumber(riskValueByKey(item, ["approvedAmount", "confirmedAmount", "finalAmount", "processedAmount", "amount", "requestAmount"])),
      requestedAt: String(riskValueByKey(item, ["createdAt", "requestDate", "created_at", "date"]) || ""),
      completedAt: String(riskValueByKey(item, ["completedAt", "approvedAt", "finishedAt", "updatedAt"]) || ""),
      bank: String(riskValueByKey(item, ["bankName", "bankTitle", "bank"]) || ""),
      account: String(riskValueByKey(item, ["accountName", "accountHolderName", "holderName", "receiverName", "senderName"]) || "")
    };
  }

  function buildBrowserDepositRisk(payload) {
    const nowMs = Date.now();
    const cutoffMs = nowMs - 60 * 60 * 1000;
    const approvedByUser = new Map();
    const activeByUser = new Map();
    const approvedIds = new Set();
    const transactions = riskTransactionArray(payload).map(compactBrowserRiskTransaction);

    for (const transaction of transactions) {
      const status = normalizeIdentity(transaction.status);
      const userKey = normalizeIdentity(transaction.user);
      if (!userKey) continue;
      const approved = /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
        && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);
      const active = /(bekli|pending|atandi|assigned|isleniyor|processing)/.test(status);
      if (approved) {
        const completedMs = riskTime(transaction, ["completedAt", "requestedAt"]);
        if (!completedMs || completedMs < cutoffMs || completedMs > nowMs + 60000) continue;
        const list = approvedByUser.get(userKey) || [];
        list.push({
          id: transaction.id,
          identifiers: transaction.identifiers,
          user: transaction.user,
          amount: transaction.amount,
          completedAt: new Date(completedMs).toISOString(),
          bank: transaction.bank,
          account: transaction.account
        });
        transaction.identifiers.forEach(identifier => approvedIds.add(identifier));
        approvedByUser.set(userKey, list);
      } else if (active) {
        if (transaction.identifiers.some(identifier => approvedIds.has(identifier))) continue;
        const list = activeByUser.get(userKey) || [];
        list.push({ transaction, requestedMs: riskTime(transaction, ["requestedAt"]) });
        activeByUser.set(userKey, list);
      }
    }

    const result = { generatedAt: new Date(nowMs).toISOString(), windowMinutes: 60, users: {}, transactions: {} };
    const userKeys = new Set([...approvedByUser.keys(), ...activeByUser.keys()]);
    for (const userKey of userKeys) {
      const approvals = (approvedByUser.get(userKey) || []).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
      const active = (activeByUser.get(userKey) || []).sort((a, b) => (a.requestedMs || nowMs) - (b.requestedMs || nowMs));
      const displayUser = active[0]?.transaction?.user || approvals[0]?.user || "";
      result.users[userKey] = { user: displayUser, approvedCount: approvals.length, activeCount: active.length, approvals };
      active.forEach((entry, index) => {
        const ordinal = approvals.length + index + 1;
        const alert = {
          id: entry.transaction.id,
          identifiers: entry.transaction.identifiers,
          user: entry.transaction.user || displayUser,
          userKey,
          ordinal,
          level: ordinal > 1 ? "repeat" : "first",
          label: ordinal > 1 ? `1 SAATTE ${ordinal}. TALEP` : "İLK TALEP · TEKRAR YOK",
          requestedAt: entry.requestedMs ? new Date(entry.requestedMs).toISOString() : "",
          previousApprovals: approvals
        };
        for (const identifier of alert.identifiers) result.transactions[identifier] = alert;
        if (alert.id) result.transactions[alert.id] = alert;
      });
    }
    result.approvedCount = [...approvedByUser.values()].reduce((sum, list) => sum + list.length, 0);
    result.activeCount = [...activeByUser.values()].reduce((sum, list) => sum + list.length, 0);
    return result;
  }

  async function fetchDepositRiskFromMoon() {
    const url = new URL("https://moon-api.aypay.co/v1/transactions");
    url.searchParams.set("type", "deposit");
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "500");
    url.searchParams.set("_", String(Date.now()));
    let payload;
    try {
      const response = await fetchWithTimeout(url.toString(), {
        credentials: "include",
        cache: "no-store",
        headers: { "Accept": "application/json, text/plain, */*" }
      }, 6000);
      if (!response.ok) throw new Error(`Moon isteği ${response.status}`);
      payload = await response.json();
    } catch {
      payload = await requestJson(url.toString(), { timeout: 6000 });
    }
    return buildBrowserDepositRisk(payload);
  }

  function closeDepositRiskPopover() {
    document.getElementById("bozok-risk-popover")?.remove();
  }

  function showDepositRiskPopover(alert, anchor) {
    closeDepositRiskPopover();
    const popover = document.createElement("div");
    popover.id = "bozok-risk-popover";
    const approvals = Array.isArray(alert.previousApprovals) ? alert.previousApprovals : [];
    const approvalHtml = approvals.length
      ? approvals.map((item, index) => `
          <div class="bozok-risk-popover-line">
            <b>${index + 1}. onay: ${formatRiskMoney(item.amount)}</b>
            <div class="bozok-risk-popover-meta">${formatRiskTime(item.completedAt)} · ${escapeRiskHtml(item.bank || "Banka yok")}${item.account ? ` / ${escapeRiskHtml(item.account)}` : ""}</div>
            ${item.id ? `<div class="bozok-risk-popover-meta">İşlem: ${escapeRiskHtml(item.id)}</div>` : ""}
          </div>`).join("")
      : `<div class="bozok-risk-popover-line">Son 60 dakika içinde daha önce onaylanmış yatırım bulunmadı.</div>`;
    popover.innerHTML = `<strong>${escapeRiskHtml(alert.label)}</strong><div>${escapeRiskHtml(alert.user || "Kullanıcı")}</div>${approvalHtml}`;
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const left = Math.min(window.innerWidth - popRect.width - 12, Math.max(12, rect.left));
    const top = rect.bottom + popRect.height + 10 < window.innerHeight
      ? rect.bottom + 8
      : Math.max(12, rect.top - popRect.height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function visibleRiskElements() {
    return [...document.querySelectorAll("tr,[role='row'],li,div")].filter(element => {
      if (element.id === "bozok-risk-popover" || element.closest("#bozok-risk-popover")) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 420 || rect.height < 34 || rect.height > 190) return false;
      const text = String(element.innerText || "").trim();
      return text.length >= 20 && text.length <= 1400;
    });
  }

  function findRiskRow(alert, candidates, usedRows) {
    const identifiers = [...new Set([alert.id, ...(alert.identifiers || [])].filter(Boolean).map(String))];
    const userKey = normalizeIdentity(alert.user);
    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      if (usedRows.has(element)) continue;
      const text = String(element.innerText || "");
      const normalized = normalizeIdentity(text);
      const identifierMatch = identifiers.some(identifier => identifier.length >= 6 && text.includes(identifier));
      const userMatch = userKey && normalized.includes(userKey);
      if (!identifierMatch && !userMatch) continue;
      const statusMatch = /bekliyor|atandı|atandi|işleniyor|isleniyor|pending|assigned/i.test(text);
      if (!identifierMatch && !statusMatch) continue;
      const score = (identifierMatch ? 10000 : 0) + (userMatch ? 1000 : 0) + (statusMatch ? 200 : 0) - text.length - element.getBoundingClientRect().height;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  function findRiskBadgeHost(row, alert) {
    const userKey = normalizeIdentity(alert.user);
    const descendants = [...row.querySelectorAll("span,p,div")].filter(element => {
      if (element.children.length > 3) return false;
      const text = String(element.innerText || "").trim();
      return text && text.length <= Math.max(80, String(alert.user || "").length + 35) && normalizeIdentity(text).includes(userKey);
    });
    return descendants.sort((a, b) => String(a.innerText || "").length - String(b.innerText || "").length)[0] || row;
  }

  function scheduleDepositRiskScan() {
    clearTimeout(depositRiskScanTimer);
    depositRiskScanTimer = setTimeout(applyDepositRiskDecorations, 120);
  }

  function applyDepositRiskDecorations() {
    const rawAlerts = Object.values(depositRiskData?.transactions || {});
    const alerts = [...new Map(rawAlerts.map(alert => [alert.id || `${alert.userKey}-${alert.requestedAt}-${alert.ordinal}`, alert])).values()];
    const activeKeys = new Set();
    const candidates = visibleRiskElements();
    const usedRows = new Set();

    alerts.sort((a, b) => Date.parse(a.requestedAt || 0) - Date.parse(b.requestedAt || 0));
    for (const alert of alerts) {
      const row = findRiskRow(alert, candidates, usedRows);
      if (!row) continue;
      usedRows.add(row);
      const key = String(alert.id || `${alert.userKey}-${alert.requestedAt}-${alert.ordinal}`);
      activeKeys.add(key);
      row.dataset.bozokRiskRow = key;
      row.classList.toggle("bozok-risk-row-repeat", alert.level === "repeat");
      row.classList.toggle("bozok-risk-row-first", alert.level !== "repeat");

      let badge = [...row.querySelectorAll(".bozok-risk-badge")].find(item => item.dataset.riskKey === key);
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "bozok-risk-badge";
        badge.dataset.riskKey = key;
        findRiskBadgeHost(row, alert).appendChild(badge);
      }
      badge.dataset.level = alert.level;
      if (badge.textContent !== alert.label) badge.textContent = alert.label;
      badge.title = alert.level === "repeat" ? "Önceki onayları görmek için tıkla" : "Son 60 dakikada önceki onay yok";
      badge.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        showDepositRiskPopover(alert, badge);
      };
    }

    document.querySelectorAll("[data-bozok-risk-row]").forEach(row => {
      if (activeKeys.has(row.dataset.bozokRiskRow)) return;
      row.classList.remove("bozok-risk-row-repeat", "bozok-risk-row-first");
      row.querySelectorAll(".bozok-risk-badge").forEach(badge => badge.remove());
      delete row.dataset.bozokRiskRow;
    });
  }

  async function refreshDepositRisk() {
    if (depositRiskInFlight) return;
    depositRiskInFlight = true;
    try {
      const url = `${getRenderBaseUrl()}/api/deposit-request-risk?_=${Date.now()}`;
      const next = await requestJson(url, { timeout: 5000 });
      if (next?.success) {
        depositRiskData = next;
        scheduleDepositRiskScan();
      }
    } catch {
      try {
        depositRiskData = await fetchDepositRiskFromMoon();
        scheduleDepositRiskScan();
      } catch {
        // Moon veya Render kısa süreli yenilenirken mevcut rozetler korunur.
      }
    } finally {
      depositRiskInFlight = false;
    }
  }

  function startDepositRiskOverlay() {
    installDepositRiskStyles();
    document.addEventListener("click", event => {
      if (!event.target.closest(".bozok-risk-badge,#bozok-risk-popover")) closeDepositRiskPopover();
    });
    depositRiskObserver = new MutationObserver(scheduleDepositRiskScan);
    depositRiskObserver.observe(document.body, { childList: true, subtree: true });
    refreshDepositRisk();
    setInterval(refreshDepositRisk, 2000);
  }

  function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getRenderBaseUrl() {
    const saved = cleanBaseUrl(GM_getValue(RENDER_URL_KEY, DEFAULT_RENDER_BASE_URL));
    if (!saved || saved.includes("raw.githack.com") || !saved.includes("onrender.com")) {
      GM_setValue(RENDER_URL_KEY, DEFAULT_RENDER_BASE_URL);
      return DEFAULT_RENDER_BASE_URL;
    }
    return saved;
  }

  function getDeviceName() {
    const saved = String(GM_getValue(DEVICE_NAME_KEY, "") || "").trim();
    if (saved) return saved;
    const generated = `Moon-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    GM_setValue(DEVICE_NAME_KEY, generated);
    return generated;
  }

  function updateStatus(text, tone = "idle") {
    if (!statusButton) return;
    const colors = {
      ok: "#14b87a",
      fail: "#ef4444",
      idle: "#64748b"
    };
    statusButton.textContent = text;
    statusButton.style.background = colors[tone] || colors.idle;
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
            reject(new Error(`İstek ${response.status}: ${String(response.responseText || "").slice(0, 80)}`));
            return;
          }
          try {
            resolve(response.responseText ? JSON.parse(response.responseText) : {});
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Bağlantı kurulamadı.")),
        ontimeout: () => reject(new Error("İstek zaman aşımı."))
      });
    });
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function browserPostJson(url, payload, timeoutMs = 8000) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Fetch ${response.status}: ${text.slice(0, 80)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async function postJsonReliable(url, payload, timeoutMs = 8000) {
    return requestJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: timeoutMs
    });
  }

  const localRequest = requestJson;

  function encodePayload(payload) {
    return btoa(encodeURIComponent(JSON.stringify(payload)));
  }

  function liveApiUrl() {
    const url = new URL(API_URL);
    url.searchParams.set("_", String(Date.now()));
    url.searchParams.set("seq", String(refreshSeq));
    return url.toString();
  }

  function liveTransactionsUrl(type, status = "") {
    const url = new URL("https://moon-api.aypay.co/v1/transactions");
    url.searchParams.set("type", type);
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "500");
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  function moonFetchOptions() {
    return {
      credentials: "include",
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    };
  }

  async function openReport() {
    button.disabled = true;
    button.textContent = "Anlık alınıyor";
    try {
      const response = await fetchWithTimeout(liveApiUrl(), moonFetchOptions(), 8000);

      if (!response.ok) {
        throw new Error(`Moon API ${response.status}`);
      }

      const payload = await response.json();
      const enrichedPayload = await enrichPayload(payload);
      await pushLocalCache(enrichedPayload, { includeLocal: true });
      window.open(`${DASHBOARD_URL}?v=${Date.now()}#report=${encodePayload(enrichedPayload)}`, "_blank", "noopener,noreferrer");
    } catch (error) {
      alert("Anlık panel verisi alınamadı. Moon oturumun açık mı kontrol et.");
    } finally {
      button.disabled = false;
      button.textContent = "Canlı";
    }
  }

  async function pushLocalCache(payload, options = {}) {
    if (options.includeLocal) {
      try {
        await postJsonReliable(LOCAL_CACHE_URL, payload, 1000);
      } catch (error) {
        // Local proxy kapalıysa rapor açma akışı yine devam eder.
      }
    }

    const renderBaseUrl = getRenderBaseUrl();
    if (!renderBaseUrl) return;
    try {
      const result = await postJsonReliable(`${renderBaseUrl}/api/moon-cache`, payload, 60000);
      if (result.skipped && !result.accepted) {
        updateStatus(`Aktif: ${result.currentDeviceName || "başka cihaz"}`, "idle");
        return result;
      }
      const time = new Date(result.updatedAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      updateStatus(`Render OK ${time}`, "ok");
      return result;
    } catch (error) {
      updateStatus(`Render hata ${String(error.message || "").slice(0, 24)}`, "fail");
      console.warn("[Bozok] Render cache gönderilemedi:", error);
      throw error;
    }
  }

  async function fetchJsonOrNull(url) {
    try {
      const response = await fetchWithTimeout(url, moonFetchOptions(), 8000);
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  function transactionArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
    if (Array.isArray(payload?.transactions)) return payload.transactions;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  function transactionAmount(item) {
    return Number(
      item.amount
      ?? item.requestAmount
      ?? item.requestedAmount
      ?? item.approvedAmount
      ?? item.totalAmount
      ?? item.price
      ?? item.value
      ?? 0
    ) || 0;
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

  function compactTransactions(payload) {
    const items = transactionArray(payload);
    return {
      data: {
        transactions: items.map(item => ({
          amount: transactionAmount(item),
          date: transactionDate(item),
          status: item.status || item.state || ""
        }))
      },
      pagination: payload?.data?.pagination || payload?.pagination || null
    };
  }

  async function enrichPayload(payload) {
    const [deposits, withdrawals, activeDeposits, activeWithdrawals] = await Promise.all([
      fetchJsonOrNull(liveTransactionsUrl("deposit")),
      fetchJsonOrNull(liveTransactionsUrl("withdrawal")),
      fetchJsonOrNull(liveTransactionsUrl("deposit", "pending,assigned")),
      fetchJsonOrNull(liveTransactionsUrl("withdrawal", "pending,assigned"))
    ]);
    return {
      ...payload,
      bozokLive: {
        capturedAt: new Date().toISOString(),
        deviceName: getDeviceName(),
        transactions: {
          deposits: compactTransactions(deposits),
          withdrawals: compactTransactions(withdrawals),
          activeDeposits: compactTransactions(activeDeposits),
          activeWithdrawals: compactTransactions(activeWithdrawals)
        }
      }
    };
  }

  async function refreshCacheSilently() {
    if (cacheInFlight && Date.now() - inFlightStartedAt < 7000) return;
    if (cacheInFlight) {
      cacheInFlight = false;
      updateStatus("Yavaş istek yenileniyor", "idle");
    }
    refreshSeq += 1;
    cacheInFlight = true;
    inFlightStartedAt = Date.now();
    try {
      await fetchAndCache(7000);
    } catch (error) {
      updateStatus(`Moon hata ${error.message}`, "fail");
    } finally {
      cacheInFlight = false;
    }
  }

  async function fetchLatestPayload(timeoutMs = 8000) {
    const response = await fetchWithTimeout(liveApiUrl(), moonFetchOptions(), timeoutMs);
    if (!response.ok) {
      throw new Error(`Moon API ${response.status}`);
    }
    return {
      ...await response.json(),
      bozokLive: {
        capturedAt: new Date().toISOString(),
        deviceName: getDeviceName(),
        mode: "fast-balance",
        seq: refreshSeq
      }
    };
  }

  async function pushRenderInBackground(payload) {
    publishLivePayload(payload);
    latestLocalPayload = payload;
    latestRenderPayload = payload;
    drainLocalQueue();
    drainRenderQueue();
  }

  function publishLivePayload(payload) {
    try {
      GM_setValue(LIVE_PAYLOAD_KEY, JSON.stringify({
        id: `${Date.now()}-${refreshSeq}`,
        payload
      }));
    } catch {}
  }

  function drainLocalQueue() {
    if (localPostInFlight) return;
    if (!latestLocalPayload) return;
    const payload = latestLocalPayload;
    latestLocalPayload = null;
    localPostInFlight = true;
    localPostStartedAt = Date.now();
    postJsonReliable(LOCAL_CACHE_URL, payload, 1000)
      .catch(() => {})
      .finally(() => {
        localPostInFlight = false;
        localPostStartedAt = 0;
        drainLocalQueue();
      });
  }

  function drainRenderQueue() {
    if (renderPostInFlight) return;
    if (!latestRenderPayload) return;
    const payload = latestRenderPayload;
    latestRenderPayload = null;
    renderPostInFlight = true;
    renderPostStartedAt = Date.now();
    pushLocalCache(payload, { includeLocal: false })
      .catch(error => {
        updateStatus(`Render hata ${String(error.message || "").slice(0, 24)}`, "fail");
      })
      .finally(() => {
        renderPostInFlight = false;
        renderPostStartedAt = 0;
        drainRenderQueue();
      });
  }

  async function fetchAndCache(timeoutMs = 8000) {
    const payload = await fetchLatestPayload(timeoutMs);
    pushRenderInBackground(payload);
    return payload;
  }

  async function completeRefresh(status, error = "") {
    await localRequest(LOCAL_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, error })
    });
  }

  async function pollRefreshRequests() {
    try {
      const data = await localRequest(LOCAL_REFRESH_URL);
      const refresh = data.refresh || {};
      if (refresh.status !== "pending" || !refresh.id || refresh.id === lastRefreshId) return;

      lastRefreshId = refresh.id;
      button.disabled = true;
      button.textContent = "Panel istiyor";
      try {
        await fetchAndCache();
        await completeRefresh("completed");
      } catch (error) {
        await completeRefresh("failed", error.message);
      } finally {
        button.disabled = false;
        button.textContent = "Canlı";
      }
    } catch (error) {}
  }

  async function requestMoonRefreshFromDashboard(department, date) {
    const data = await localRequest(LOCAL_REFRESH_URL, { method: "POST" });
    const refreshId = data.refresh?.id;
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const statusData = await localRequest(LOCAL_REFRESH_URL);
      const refresh = statusData.refresh || {};
      if (refresh.id !== refreshId) continue;
      if (refresh.status === "failed") throw new Error(refresh.error || "Moon verisi alınamadı.");
      if (refresh.status === "completed") {
        const reportUrl = new URL(LOCAL_REPORT_URL);
        reportUrl.searchParams.set("department", department || "Şimşek");
        reportUrl.searchParams.set("date", date || "");
        return localRequest(reportUrl.toString());
      }
    }

    throw new Error("Moon sekmesi yanıt vermedi. Moon açık ve girişli mi?");
  }

  function installDashboardBridge() {
    console.log("[Bozok] Dashboard canlı köprü aktif.");
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(LIVE_PAYLOAD_KEY, (_name, _oldValue, newValue) => {
        try {
          const data = JSON.parse(newValue || "{}");
          if (!data.payload) return;
          window.postMessage({
            type: "bozok:moon-payload",
            payload: data.payload
          }, window.location.origin);
        } catch {}
      });
      try {
        const current = JSON.parse(GM_getValue(LIVE_PAYLOAD_KEY, "{}"));
        if (current.payload) {
          window.postMessage({
            type: "bozok:moon-payload",
            payload: current.payload
          }, window.location.origin);
        }
      } catch {}
    }
    window.addEventListener("message", async event => {
      const detail = event.data || {};
      if (event.source !== window || detail.type !== "bozok:moon-refresh-request") return;
      try {
        const report = await requestMoonRefreshFromDashboard(detail.department, detail.date);
        window.postMessage({
          type: "bozok:moon-refresh-result",
          requestId: detail.requestId,
          report
        }, window.location.origin);
      } catch (error) {
        window.postMessage({
          type: "bozok:moon-refresh-result",
          requestId: detail.requestId,
          error: error.message
        }, window.location.origin);
      }
    });

    setInterval(async () => {
      try {
        const reportUrl = new URL(`${getRenderBaseUrl()}/api/end-day`);
        reportUrl.searchParams.set("department", document.getElementById("reportDepartment")?.value?.trim() || "Şimşek");
        reportUrl.searchParams.set("date", document.getElementById("reportDate")?.value || "");
        const report = await requestJson(reportUrl.toString());
        window.postMessage({
          type: "bozok:cached-report",
          report
        }, window.location.origin);
      } catch (error) {}
    }, 1000);
  }

  if (location.hostname === "raw.githack.com" || location.hostname.endsWith(".onrender.com")) {
    if (location.hostname.endsWith(".onrender.com")) {
      GM_setValue(RENDER_URL_KEY, location.origin);
    }
    installDashboardBridge();
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Canlı";
  button.style.cssText = [
    "position:fixed",
    "right:18px",
    "bottom:18px",
    "z-index:2147483647",
    "height:42px",
    "padding:0 16px",
    "border:1px solid rgba(255,255,255,.22)",
    "border-radius:10px",
    "background:#18b981",
    "color:#fff",
    "font:800 13px Arial,sans-serif",
    "box-shadow:0 14px 34px rgba(0,0,0,.32)",
    "cursor:pointer"
  ].join(";");
  button.addEventListener("click", openReport);

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.textContent = "Render";
  settingsButton.style.cssText = [
    "position:fixed",
    "right:18px",
    "bottom:66px",
    "z-index:2147483647",
    "height:34px",
    "padding:0 12px",
    "border:1px solid rgba(255,255,255,.22)",
    "border-radius:9px",
    "background:#272b38",
    "color:#fff",
    "font:800 12px Arial,sans-serif",
    "box-shadow:0 12px 28px rgba(0,0,0,.26)",
    "cursor:pointer"
  ].join(";");
  settingsButton.addEventListener("click", () => {
    const current = getRenderBaseUrl();
    const value = prompt("Render dashboard linkini yapıştır:", current || "https://....onrender.com");
    if (value === null) return;
    GM_setValue(RENDER_URL_KEY, cleanBaseUrl(value));
    const device = prompt("Bu cihazın adı:", getDeviceName());
    if (device !== null && device.trim()) GM_setValue(DEVICE_NAME_KEY, device.trim());
    alert("Render linki ve cihaz adı kaydedildi. Moon verisi artık bu sunucuya da aktarılacak.");
  });

  const statusButton = document.createElement("button");
  statusButton.type = "button";
  statusButton.textContent = "Bekliyor";
  statusButton.style.cssText = [
    "position:fixed",
    "right:86px",
    "bottom:18px",
    "z-index:2147483647",
    "height:42px",
    "padding:0 14px",
    "border:1px solid rgba(255,255,255,.22)",
    "border-radius:10px",
    "background:#64748b",
    "color:#fff",
    "font:800 12px Arial,sans-serif",
    "box-shadow:0 14px 34px rgba(0,0,0,.32)"
  ].join(";");

  function startMoonBridge() {
    if (moonBridgeStarted) return;
    moonBridgeStarted = true;
    document.body.appendChild(button);
    document.body.appendChild(settingsButton);
    document.body.appendChild(statusButton);
    startDepositRiskOverlay();
    updateStatus("Başladı", "idle");
    refreshCacheSilently();
    refreshTimer = setInterval(refreshCacheSilently, 1000);
    setInterval(pollRefreshRequests, 1500);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshCacheSilently();
    });
    window.addEventListener("focus", () => refreshCacheSilently());
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", startMoonBridge, { once: true });
  } else {
    startMoonBridge();
  }
})();
