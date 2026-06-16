// ==UserScript==
// @name         Bozok Anlık Panel Bakiye Aktarıcı
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      2.7.0
// @description  Moon yatırım taleplerinde kalıcı tekrar kontrolü ve 30 günlük güven profili gösterir.
// @downloadURL  https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-moon-alerts.user.js
// @updateURL    https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/bozok-moon-alerts.user.js
// @match        https://moon.aypay.co/*
// @grant        GM_xmlhttpRequest
// @connect      bozok-financial-dashboard.onrender.com
// @connect      moon-api.aypay.co
// @require      https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/moon-deposit-alerts.js?v=2.7.0
// @run-at       document-idle
// ==/UserScript==

// Temiz kurulum dosyasıdır. Eski bakiye köprüsünü ve sabit butonları içermez.
