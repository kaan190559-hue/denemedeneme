// ==UserScript==
// @name         Bozok Gün Sonu Rapor Aktarıcı
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.1.0
// @description  Moon AyPAY departman bakiyesini Bozok dashboard ve Telegram bot cache'ine aktarır.
// @match        https://moon.aypay.co/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const DASHBOARD_URL = "https://raw.githack.com/kaan190559-hue/denemedeneme/main/index.html";
  const API_URL = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
  const LOCAL_CACHE_URL = "http://localhost:8787/api/moon-cache";
  const LOCAL_REFRESH_URL = "http://localhost:8787/api/moon-refresh";
  let lastRefreshId = "";

  function encodePayload(payload) {
    return btoa(encodeURIComponent(JSON.stringify(payload)));
  }

  async function openReport() {
    button.disabled = true;
    button.textContent = "Rapor alınıyor";
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
      alert("Gün sonu verisi alınamadı. Moon oturumun açık mı kontrol et.");
    } finally {
      button.disabled = false;
      button.textContent = "Gün Sonu";
    }
  }

  async function pushLocalCache(payload) {
    try {
      await fetch(LOCAL_CACHE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      // Local proxy kapalıysa rapor açma akışı yine devam eder.
    }
  }

  async function refreshCacheSilently() {
    try {
      await fetchAndCache();
    } catch (error) {}
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
    await fetch(LOCAL_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, error })
    });
  }

  async function pollRefreshRequests() {
    try {
      const response = await fetch(LOCAL_REFRESH_URL);
      if (!response.ok) return;
      const data = await response.json();
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
        button.textContent = "Gün Sonu";
      }
    } catch (error) {}
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Gün Sonu";
  button.style.cssText = [
    "position:fixed",
    "right:18px",
    "bottom:18px",
    "z-index:2147483647",
    "height:42px",
    "padding:0 16px",
    "border:1px solid rgba(255,255,255,.22)",
    "border-radius:10px",
    "background:#7c5cff",
    "color:#fff",
    "font:800 13px Arial,sans-serif",
    "box-shadow:0 14px 34px rgba(0,0,0,.32)",
    "cursor:pointer"
  ].join(";");
  button.addEventListener("click", openReport);

  window.addEventListener("load", () => {
    document.body.appendChild(button);
    refreshCacheSilently();
    setInterval(refreshCacheSilently, 60000);
    setInterval(pollRefreshRequests, 1500);
  });
})();
