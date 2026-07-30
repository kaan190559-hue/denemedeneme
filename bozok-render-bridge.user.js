// ==UserScript==
// @name         Bozok Moon Köprüsü
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.1.0
// @description  Açık Moon oturumundan Bozok panel DB'sine bakiye aktarır (Hetzner veya Render).
// @downloadURL  https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-render-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-render-bridge.user.js
// @author       Bozok
// @match        https://moon.aypay.co/*
// @icon         https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/icon.png
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bozok.vivipay.uk
// @connect      *.vivipay.uk
// @connect      bozok-financial-dashboard.onrender.com
// @connect      *.onrender.com
// @connect      moon-api.aypay.co
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    RENDER_BASE_URL: "https://bozok.vivipay.uk",
    MOON_API: "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500",
    POLL_MS: 30000,
    FETCH_TIMEOUT_MS: 12000,
    POST_TIMEOUT_MS: 60000,
    DEVICE_KEY: "bozokRenderBridgeDevice",
    RENDER_KEY: "bozokRenderBridgeUrl"
  };

  let pollTimer = 0;
  let inFlight = false;
  let postInFlight = false;
  let seq = 0;

  function cleanUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function getRenderBaseUrl() {
    const saved = cleanUrl(GM_getValue(CONFIG.RENDER_KEY, CONFIG.RENDER_BASE_URL));
    if (!saved.includes("onrender.com")) return CONFIG.RENDER_BASE_URL;
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
        seq
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
    statusEl.textContent = text;
    statusEl.style.background = colors[tone] || colors.idle;
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
  }

  const statusEl = document.createElement("button");
  statusEl.type = "button";
  statusEl.title = "Bozok Render Köprüsü — tıkla: ayarlar, çift tık: hemen gönder";
  statusEl.textContent = "Bozok köprü";
  statusEl.style.cssText = [
    "position:fixed",
    "right:14px",
    "bottom:14px",
    "z-index:2147483646",
    "padding:8px 12px",
    "border:1px solid rgba(255,255,255,.22)",
    "border-radius:10px",
    "background:#64748b",
    "color:#fff",
    "font:800 11px/1.2 system-ui,sans-serif",
    "cursor:pointer",
    "box-shadow:0 10px 28px rgba(0,0,0,.28)"
  ].join(";");
  statusEl.addEventListener("click", openSettings);
  statusEl.addEventListener("dblclick", event => {
    event.preventDefault();
    syncOnce();
  });

  function start() {
    document.body.appendChild(statusEl);
    setStatus(`Başladı (${CONFIG.POLL_MS / 1000}s)`, "idle");
    syncOnce();
    schedulePoll();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncOnce();
    });
    window.addEventListener("focus", syncOnce);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
