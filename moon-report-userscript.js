// ==UserScript==
// @name         Bozok Anlık Panel Bakiye Aktarıcı
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.6.9
// @description  Moon AyPAY departman bakiyesini Bozok dashboard ve Telegram bot cache'ine aktarır.
// @downloadURL  https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/moon-report-userscript.js
// @updateURL    https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/moon-report-userscript.js
// @match        https://moon.aypay.co/*
// @match        https://raw.githack.com/kaan190559-hue/denemedeneme/*
// @match        https://*.onrender.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
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
  const DEFAULT_RENDER_BASE_URL = "https://bozok-financial-dashboard.onrender.com";
  let lastRefreshId = "";
  let cacheInFlight = false;
  let moonBridgeStarted = false;
  let refreshSeq = 0;
  let refreshTimer = 0;
  let inFlightStartedAt = 0;

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

  async function browserPostJson(url, payload) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, 8000);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Fetch ${response.status}: ${text.slice(0, 80)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async function postJsonReliable(url, payload) {
    try {
      return await browserPostJson(url, payload);
    } catch (fetchError) {
      return requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
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
      await pushLocalCache(enrichedPayload);
      window.open(`${DASHBOARD_URL}?v=${Date.now()}#report=${encodePayload(enrichedPayload)}`, "_blank", "noopener,noreferrer");
    } catch (error) {
      alert("Anlık panel verisi alınamadı. Moon oturumun açık mı kontrol et.");
    } finally {
      button.disabled = false;
      button.textContent = "Canlı";
    }
  }

  async function pushLocalCache(payload) {
    try {
      await postJsonReliable(LOCAL_CACHE_URL, payload);
    } catch (error) {
      // Local proxy kapalıysa rapor açma akışı yine devam eder.
    }

    const renderBaseUrl = getRenderBaseUrl();
    if (!renderBaseUrl) return;
    try {
      const result = await postJsonReliable(`${renderBaseUrl}/api/moon-cache`, payload);
      updateStatus(`Render OK ${new Date(result.updatedAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, "ok");
    } catch (error) {
      updateStatus(`Render hata ${String(error.message || "").slice(0, 24)}`, "fail");
      console.warn("[Bozok] Render cache gönderilemedi:", error);
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
    if (cacheInFlight && Date.now() - inFlightStartedAt < 9000) return;
    if (cacheInFlight) {
      cacheInFlight = false;
      updateStatus("Takılan istek sıfırlandı", "idle");
    }
    refreshSeq += 1;
    cacheInFlight = true;
    inFlightStartedAt = Date.now();
    try {
      await fetchAndCache();
    } catch (error) {
      updateStatus(`Moon hata ${error.message}`, "fail");
    } finally {
      cacheInFlight = false;
    }
  }

  async function fetchAndCache() {
    const response = await fetchWithTimeout(liveApiUrl(), moonFetchOptions(), 8000);
    if (!response.ok) {
      throw new Error(`Moon API ${response.status}`);
    }
    const payload = {
      ...await response.json(),
      bozokLive: {
        capturedAt: new Date().toISOString(),
        mode: "fast-balance",
        seq: refreshSeq
      }
    };
    await pushLocalCache(payload);
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
        const reportUrl = new URL(LOCAL_REPORT_URL);
        reportUrl.searchParams.set("department", document.getElementById("reportDepartment")?.value?.trim() || "Şimşek");
        reportUrl.searchParams.set("date", document.getElementById("reportDate")?.value || "");
        const report = await localRequest(reportUrl.toString());
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
    alert("Render linki kaydedildi. Moon verisi artık bu sunucuya da aktarılacak.");
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
