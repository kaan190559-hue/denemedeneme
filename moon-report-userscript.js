// ==UserScript==
// @name         Bozok Anlık Panel Bakiye Aktarıcı
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.6.1
// @description  Moon AyPAY departman bakiyesini Bozok dashboard ve Telegram bot cache'ine aktarır.
// @match        https://moon.aypay.co/*
// @match        https://raw.githack.com/kaan190559-hue/denemedeneme/*
// @match        https://*.onrender.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      localhost
// @connect      127.0.0.1
// @connect      *.onrender.com
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

  function cleanBaseUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getRenderBaseUrl() {
    return cleanBaseUrl(GM_getValue(RENDER_URL_KEY, DEFAULT_RENDER_BASE_URL));
  }

  function requestJson(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url,
        headers: options.headers || {},
        data: options.body,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`İstek ${response.status}`));
            return;
          }
          try {
            resolve(response.responseText ? JSON.parse(response.responseText) : {});
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("Bağlantı kurulamadı."))
      });
    });
  }

  const localRequest = requestJson;

  function encodePayload(payload) {
    return btoa(encodeURIComponent(JSON.stringify(payload)));
  }

  async function openReport() {
    button.disabled = true;
    button.textContent = "Anlık alınıyor";
    try {
      const response = await fetch(API_URL, {
        credentials: "include",
        headers: {
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(`Moon API ${response.status}`);
      }

      const payload = await response.json();
      await pushLocalCache(payload);
      window.open(`${DASHBOARD_URL}?v=${Date.now()}#report=${encodePayload(payload)}`, "_blank", "noopener,noreferrer");
    } catch (error) {
      alert("Anlık panel verisi alınamadı. Moon oturumun açık mı kontrol et.");
    } finally {
      button.disabled = false;
      button.textContent = "Canlı";
    }
  }

  async function pushLocalCache(payload) {
    try {
      await requestJson(LOCAL_CACHE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      // Local proxy kapalıysa rapor açma akışı yine devam eder.
    }

    const renderBaseUrl = getRenderBaseUrl();
    if (!renderBaseUrl) return;
    try {
      await requestJson(`${renderBaseUrl}/api/moon-cache`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.warn("[Bozok] Render cache gönderilemedi:", error);
    }
  }

  async function refreshCacheSilently() {
    if (cacheInFlight) return;
    cacheInFlight = true;
    try {
      await fetchAndCache();
    } catch (error) {
    } finally {
      cacheInFlight = false;
    }
  }

  async function fetchAndCache() {
    const response = await fetch(API_URL, {
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      throw new Error(`Moon API ${response.status}`);
    }
    const payload = await response.json();
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

  window.addEventListener("load", () => {
    document.body.appendChild(button);
    document.body.appendChild(settingsButton);
    refreshCacheSilently();
    setInterval(refreshCacheSilently, 1000);
    setInterval(pollRefreshRequests, 1500);
  });
})();
