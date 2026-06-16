// ==UserScript==
// @name         Bozok Moon Alerts v3
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      3.0.0
// @description  Moon yatırım taleplerinde tekrar kontrolü ve 30 günlük profil gösterir
// @author       Bozok
// @match        https://moon.aypay.co/deposits
// @icon         https://raw.githubusercontent.com/kaan190559-hue/denemedeneme/main/icon.png
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      moon-api.aypay.co
// @connect      bozok-financial-dashboard.onrender.com
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  // ===== KONSTANTİKLER =====
  const CONFIG = {
    API_BASE: 'https://moon-api.aypay.co/v1',
    POLL_INTERVAL: 5000,      // 5 saniye
    PROFILE_WINDOW: 30,        // 30 gün
    PROFILE_CACHE_TTL: 120000, // 2 dakika
    DOM_CHECK_INTERVAL: 5000,  // DOM kontrol süresi
  };

  // ===== DEPOLAMA YÖNETİMİ =====
  const Storage = {
    getRequests() {
      try {
        return JSON.parse(GM_getValue('moon_requests', '{}'));
      } catch {
        return {};
      }
    },
    
    setRequest(username, requestData) {
      const requests = this.getRequests();
      requests[username] = {
        ...requestData,
        timestamp: Date.now(),
      };
      GM_setValue('moon_requests', JSON.stringify(requests));
    },
    
    getProfileCache(username) {
      try {
        const cache = JSON.parse(GM_getValue(`moon_profile_${username}`, 'null'));
        if (!cache) return null;
        if (Date.now() - cache.fetchedAt > CONFIG.PROFILE_CACHE_TTL) {
          return null; // Cache süresi doldu
        }
        return cache.data;
      } catch {
        return null;
      }
    },
    
    setProfileCache(username, profileData) {
      const cache = {
        data: profileData,
        fetchedAt: Date.now(),
      };
      GM_setValue(`moon_profile_${username}`, JSON.stringify(cache));
    },
  };

  // ===== API İŞLEMLERİ =====
  class API {
    static async fetchProfile(username) {
      return new Promise((resolve) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `${CONFIG.API_BASE}/users/${username}/profile?days=${CONFIG.PROFILE_WINDOW}`,
          timeout: 5000,
          onload(response) {
            try {
              if (response.status === 200) {
                const profile = JSON.parse(response.responseText);
                Storage.setProfileCache(username, profile);
                resolve(profile);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          },
          onerror() {
            resolve(null);
          },
        });
      });
    }
  }

  // ===== CARD IŞLEMLER =====
  class CardManager {
    constructor() {
      this.activeAlerts = new Map();
      this.observer = null;
    }

    init() {
      this.installStyles();
      this.startObserving();
      this.checkExistingCards();
    }

    installStyles() {
      if (document.getElementById('moon-alerts-styles')) return;

      const style = document.createElement('style');
      style.id = 'moon-alerts-styles';
      style.textContent = `
        .moon-alert-badge {
          display: inline-block;
          margin-left: 8px;
          padding: 4px 12px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border-radius: 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s ease;
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }

        .moon-alert-badge:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }

        .moon-alert-popover {
          position: fixed;
          z-index: 10000;
          background: rgba(30, 30, 40, 0.95);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
          min-width: 300px;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }

        .moon-popover-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 12px;
          color: #fff;
        }

        .moon-popover-stat {
          display: flex;
          justify-content: space-between;
          margin: 8px 0;
          font-size: 13px;
          color: rgba(255, 255, 255, 0.8);
        }

        .moon-popover-stat strong {
          color: #fff;
        }
      `;
      document.head.appendChild(style);
    }

    startObserving() {
      const target = document.getElementById('app') || document.body;
      
      this.observer = new MutationObserver(() => {
        this.checkExistingCards();
      });

      this.observer.observe(target, {
        childList: true,
        subtree: true,
      });
    }

    checkExistingCards() {
      // Tüm tablo satırlarını bul
      const rows = document.querySelectorAll('tr');
      
      rows.forEach((row) => {
        const username = this.extractUsername(row);
        if (!username) return;

        const key = `card_${username}`;
        if (this.activeAlerts.has(key)) return; // Zaten işlenmiş

        this.processRow(row, username);
      });
    }

    extractUsername(row) {
      const nameCell = row.querySelector('td:nth-child(1)');
      if (!nameCell) return null;
      
      const text = nameCell.textContent.trim();
      return text || null;
    }

    async processRow(row, username) {
      const key = `card_${username}`;
      this.activeAlerts.set(key, true);

      // Ordinal
      const ordinal = this.activeAlerts.size;

      // Badge oluştur
      const badge = this.createBadge(`${ordinal}. talep`);
      
      const lastCell = row.querySelector('td:last-child');
      if (lastCell) {
        lastCell.appendChild(badge);
      }

      // Profil verisini getir
      const profile = await this.getProfile(username);
      
      if (profile) {
        const displayText = `30G %${Math.round(profile.successRate || 0)}`;
        badge.textContent = displayText;
      }

      // Popover
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showPopover(username, profile, badge, ordinal);
      });
    }

    async getProfile(username) {
      // Cache'ten kontrol et
      let profile = Storage.getProfileCache(username);
      if (profile) return profile;

      // API'den getir
      profile = await API.fetchProfile(username);
      return profile;
    }

    createBadge(text) {
      const badge = document.createElement('span');
      badge.className = 'moon-alert-badge';
      badge.textContent = text;
      return badge;
    }

    showPopover(username, profile, anchor, ordinal) {
      // Eski popover varsa kapat
      document.querySelectorAll('.moon-alert-popover').forEach(p => p.remove());

      if (!profile) {
        const popover = document.createElement('div');
        popover.className = 'moon-alert-popover';
        popover.innerHTML = `
          <div class="moon-popover-title">Kullanıcı: ${username}</div>
          <div style="color: rgba(255,255,255,0.6); font-size: 13px;">
            Profil verisi yükleniyor...
          </div>
        `;
        document.body.appendChild(popover);
        this.positionPopover(popover, anchor);
        return;
      }

      const popover = document.createElement('div');
      popover.className = 'moon-alert-popover';
      popover.innerHTML = `
        <div class="moon-popover-title">${ordinal}. Talep - ${username}</div>
        <div class="moon-popover-stat">
          <span>Toplam Talep:</span>
          <strong>${profile.totalRequests || 0}</strong>
        </div>
        <div class="moon-popover-stat">
          <span>Onaylı:</span>
          <strong>${profile.approvedCount || 0}</strong>
        </div>
        <div class="moon-popover-stat">
          <span>Reddedilen:</span>
          <strong>${profile.failedCount || 0}</strong>
        </div>
        <div class="moon-popover-stat">
          <span>Beklemede:</span>
          <strong>${profile.pendingCount || 0}</strong>
        </div>
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1);">
          <div class="moon-popover-stat">
            <span>Başarı Oranı:</span>
            <strong>${Math.round(profile.successRate || 0)}%</strong>
          </div>
          <div class="moon-popover-stat">
            <span>Çözülmüş Başarı:</span>
            <strong>${Math.round(profile.resolvedSuccessRate || 0)}%</strong>
          </div>
        </div>
      `;

      document.body.appendChild(popover);
      this.positionPopover(popover, anchor);

      // Popover kapatma
      document.addEventListener('click', function closePopover(e) {
        if (e.target !== anchor && !popover.contains(e.target)) {
          popover.remove();
          document.removeEventListener('click', closePopover);
        }
      });
    }

    positionPopover(popover, anchor) {
      const rect = anchor.getBoundingClientRect();
      popover.style.left = `${rect.left}px`;
      popover.style.top = `${rect.bottom + 8}px`;
    }
  }

  // ===== BAŞLATMA =====
  function start() {
    const manager = new CardManager();
    manager.init();
  }

  // DOM hazır olduğunda başla
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
