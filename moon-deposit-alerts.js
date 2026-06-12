(function () {
  "use strict";

  const RENDER_RISK_URL = "https://bozok-financial-dashboard.onrender.com/api/deposit-request-risk";
  const MOON_TRANSACTIONS_URL = "https://moon-api.aypay.co/v1/transactions";
  const POLL_MS = 2000;
  let riskData = null;
  let requestInFlight = false;
  let scanTimer = 0;

  function normalize(value) {
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

  function valueByKey(source, keys) {
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

  function transactionArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
    if (Array.isArray(payload?.transactions)) return payload.transactions;
    if (Array.isArray(payload?.data)) return payload.data;
    return [];
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

  function dateMs(source, keys) {
    for (const key of keys) {
      const parsed = Date.parse(valueByKey(source, [key]) || "");
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function compactTransaction(item = {}) {
    const identifiers = ["_id", "id", "transactionId", "processId", "operationId", "requestId", "uuid"]
      .map(key => valueByKey(item, [key]))
      .map(value => String(value || "").trim())
      .filter(Boolean);
    return {
      id: identifiers[0] || "",
      identifiers: [...new Set(identifiers)],
      user: String(valueByKey(item, ["userName", "username", "customerName", "fullName", "name"]) || ""),
      status: String(valueByKey(item, ["status", "state"]) || ""),
      amount: parseMoney(valueByKey(item, ["approvedAmount", "confirmedAmount", "finalAmount", "processedAmount", "amount", "requestAmount"])),
      requestedAt: String(valueByKey(item, ["createdAt", "requestDate", "created_at", "date"]) || ""),
      completedAt: String(valueByKey(item, ["completedAt", "approvedAt", "finishedAt", "updatedAt"]) || ""),
      bank: String(valueByKey(item, ["bankName", "bankTitle", "bank"]) || ""),
      account: String(valueByKey(item, ["accountName", "accountHolderName", "holderName", "receiverName", "senderName"]) || "")
    };
  }

  function buildRisk(payload) {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const approvedByUser = new Map();
    const activeByUser = new Map();
    const approvedIds = new Set();

    for (const transaction of transactionArray(payload).map(compactTransaction)) {
      const status = normalize(transaction.status);
      const userKey = normalize(transaction.user);
      if (!userKey) continue;
      const approved = /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
        && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);
      const active = /(bekli|pending|atandi|assigned|isleniyor|processing)/.test(status);

      if (approved) {
        const completedAt = dateMs(transaction, ["completedAt", "requestedAt"]);
        if (!completedAt || completedAt < cutoff || completedAt > now + 60000) continue;
        const list = approvedByUser.get(userKey) || [];
        list.push({
          id: transaction.id,
          user: transaction.user,
          amount: transaction.amount,
          completedAt: new Date(completedAt).toISOString(),
          bank: transaction.bank,
          account: transaction.account
        });
        transaction.identifiers.forEach(identifier => approvedIds.add(identifier));
        approvedByUser.set(userKey, list);
      } else if (active && !transaction.identifiers.some(identifier => approvedIds.has(identifier))) {
        const list = activeByUser.get(userKey) || [];
        list.push({ transaction, requestedAt: dateMs(transaction, ["requestedAt"]) });
        activeByUser.set(userKey, list);
      }
    }

    const result = { success: true, generatedAt: new Date(now).toISOString(), windowMinutes: 60, transactions: {} };
    const userKeys = new Set([...approvedByUser.keys(), ...activeByUser.keys()]);
    for (const userKey of userKeys) {
      const approvals = (approvedByUser.get(userKey) || []).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
      const active = (activeByUser.get(userKey) || []).sort((a, b) => (a.requestedAt || now) - (b.requestedAt || now));
      active.forEach((entry, index) => {
        const ordinal = approvals.length + index + 1;
        const alert = {
          id: entry.transaction.id,
          identifiers: entry.transaction.identifiers,
          user: entry.transaction.user,
          userKey,
          ordinal,
          level: ordinal > 1 ? "repeat" : "first",
          label: ordinal > 1 ? `1 SAATTE ${ordinal}. TALEP` : "İLK TALEP · TEKRAR YOK",
          requestedAt: entry.requestedAt ? new Date(entry.requestedAt).toISOString() : "",
          previousApprovals: approvals
        };
        alert.identifiers.forEach(identifier => { result.transactions[identifier] = alert; });
        if (alert.id) result.transactions[alert.id] = alert;
      });
    }
    return result;
  }

  function requestJson(url, timeout = 6000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout,
        headers: { "Accept": "application/json, text/plain, */*" },
        onload: response => {
          if (response.status < 200 || response.status >= 300) return reject(new Error(`HTTP ${response.status}`));
          try { resolve(JSON.parse(response.responseText || "{}")); } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error("Bağlantı kurulamadı")),
        ontimeout: () => reject(new Error("Zaman aşımı"))
      });
    });
  }

  async function fetchMoonRisk() {
    const url = new URL(MOON_TRANSACTIONS_URL);
    url.searchParams.set("type", "deposit");
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "500");
    url.searchParams.set("_", String(Date.now()));
    let payload;
    try {
      const response = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Accept": "application/json, text/plain, */*" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch {
      payload = await requestJson(url.toString());
    }
    return buildRisk(payload);
  }

  function installStyles() {
    if (document.getElementById("bozok-deposit-alert-styles")) return;
    const style = document.createElement("style");
    style.id = "bozok-deposit-alert-styles";
    style.textContent = `
      .bozok-alert-repeat{box-shadow:inset 4px 0 0 #ef4444!important;background-image:linear-gradient(90deg,rgba(239,68,68,.12),transparent 35%)!important}
      .bozok-alert-first{box-shadow:inset 4px 0 0 #22c55e!important;background-image:linear-gradient(90deg,rgba(34,197,94,.08),transparent 28%)!important}
      .bozok-alert-badge{display:inline-flex!important;align-items:center;gap:5px;min-height:22px;margin-left:8px;padding:2px 8px;border:1px solid transparent;border-radius:6px;font:700 11px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;user-select:none}
      .bozok-alert-badge[data-level="repeat"]{color:#fecaca;background:#7f1d1d;border-color:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.12)}
      .bozok-alert-badge[data-level="first"]{color:#bbf7d0;background:#14532d;border-color:#22c55e}
      #bozok-alert-popover{position:fixed;z-index:2147483647;width:min(360px,calc(100vw - 24px));padding:14px;border:1px solid #334155;border-radius:10px;background:#0f172a;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,.5);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
      #bozok-alert-popover strong{display:block;margin-bottom:7px;color:#fff;font-size:14px}.bozok-alert-line{padding:7px 0;border-top:1px solid rgba(148,163,184,.18)}.bozok-alert-meta{color:#94a3b8;font-size:12px}
    `;
    document.head.appendChild(style);
  }

  function money(value) {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function displayTime(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "Saat bilinmiyor";
  }

  function showPopover(alert, anchor) {
    document.getElementById("bozok-alert-popover")?.remove();
    const popover = document.createElement("div");
    popover.id = "bozok-alert-popover";
    const approvals = Array.isArray(alert.previousApprovals) ? alert.previousApprovals : [];
    const lines = approvals.length ? approvals.map((item, index) => `
      <div class="bozok-alert-line"><b>${index + 1}. onay: ${money(item.amount)}</b>
      <div class="bozok-alert-meta">${displayTime(item.completedAt)} · ${escapeHtml(item.bank || "Banka yok")}${item.account ? ` / ${escapeHtml(item.account)}` : ""}</div></div>`).join("")
      : `<div class="bozok-alert-line">Son 60 dakikada daha önce onaylanan yatırım yok.</div>`;
    popover.innerHTML = `<strong>${escapeHtml(alert.label)}</strong><div>${escapeHtml(alert.user || "Kullanıcı")}</div>${lines}`;
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    popover.style.left = `${Math.min(innerWidth - popRect.width - 12, Math.max(12, rect.left))}px`;
    popover.style.top = `${rect.bottom + popRect.height + 10 < innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - popRect.height - 8)}px`;
  }

  function candidates() {
    return [...document.querySelectorAll("tr,[role='row'],li,div")].filter(element => {
      if (element.closest("#bozok-alert-popover")) return false;
      const rect = element.getBoundingClientRect();
      const text = String(element.innerText || "").trim();
      return rect.width >= 420 && rect.height >= 34 && rect.height <= 190 && text.length >= 20 && text.length <= 1400;
    });
  }

  function findRow(alert, rows, used) {
    const identifiers = [...new Set([alert.id, ...(alert.identifiers || [])].filter(Boolean).map(String))];
    const userKey = normalize(alert.user);
    let best = null;
    let bestScore = -Infinity;
    for (const row of rows) {
      if (used.has(row)) continue;
      const text = String(row.innerText || "");
      const normalizedText = normalize(text);
      const idMatch = identifiers.some(id => id.length >= 6 && text.includes(id));
      const userMatch = userKey && normalizedText.includes(userKey);
      const pendingMatch = /bekliyor|atandı|atandi|işleniyor|isleniyor|pending|assigned/i.test(text);
      if ((!idMatch && !userMatch) || (!idMatch && !pendingMatch)) continue;
      const score = (idMatch ? 10000 : 0) + (userMatch ? 1000 : 0) + (pendingMatch ? 200 : 0) - text.length - row.getBoundingClientRect().height;
      if (score > bestScore) { best = row; bestScore = score; }
    }
    return best;
  }

  function badgeHost(row, alert) {
    const userKey = normalize(alert.user);
    return [...row.querySelectorAll("span,p,div")]
      .filter(element => {
        const text = String(element.innerText || "").trim();
        return element.children.length <= 3 && text && text.length <= Math.max(80, String(alert.user || "").length + 35) && normalize(text).includes(userKey);
      })
      .sort((a, b) => String(a.innerText || "").length - String(b.innerText || "").length)[0] || row;
  }

  function applyAlerts() {
    const alerts = [...new Map(Object.values(riskData?.transactions || {}).map(alert => [alert.id || `${alert.userKey}-${alert.requestedAt}`, alert])).values()];
    const rows = candidates();
    const used = new Set();
    const active = new Set();
    for (const alert of alerts) {
      const row = findRow(alert, rows, used);
      if (!row) continue;
      used.add(row);
      const key = String(alert.id || `${alert.userKey}-${alert.requestedAt}`);
      active.add(key);
      row.dataset.bozokAlertRow = key;
      row.classList.toggle("bozok-alert-repeat", alert.level === "repeat");
      row.classList.toggle("bozok-alert-first", alert.level !== "repeat");
      let badge = [...row.querySelectorAll(".bozok-alert-badge")].find(item => item.dataset.alertKey === key);
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "bozok-alert-badge";
        badge.dataset.alertKey = key;
        badgeHost(row, alert).appendChild(badge);
      }
      badge.dataset.level = alert.level;
      badge.textContent = alert.label;
      badge.onclick = event => { event.preventDefault(); event.stopPropagation(); showPopover(alert, badge); };
    }
    document.querySelectorAll("[data-bozok-alert-row]").forEach(row => {
      if (active.has(row.dataset.bozokAlertRow)) return;
      row.classList.remove("bozok-alert-repeat", "bozok-alert-first");
      row.querySelectorAll(".bozok-alert-badge").forEach(badge => badge.remove());
      delete row.dataset.bozokAlertRow;
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(applyAlerts, 100);
  }

  async function refresh() {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const serverRisk = await requestJson(`${RENDER_RISK_URL}?_=${Date.now()}`, 4500);
      if (!serverRisk?.success) throw new Error("Sunucu özeti yok");
      riskData = serverRisk;
    } catch {
      try { riskData = await fetchMoonRisk(); } catch { /* Existing badges remain visible. */ }
    } finally {
      requestInFlight = false;
      scheduleScan();
    }
  }

  function removeLegacyBridgeUi() {
    document.querySelectorAll("button").forEach(button => {
      const text = String(button.textContent || "").trim();
      const style = getComputedStyle(button);
      if (style.position === "fixed" && (text === "Render" || text === "Canlı" || text === "Bekliyor" || /^Aktif:/.test(text))) button.remove();
    });
  }

  function start() {
    installStyles();
    removeLegacyBridgeUi();
    document.addEventListener("click", event => {
      if (!event.target.closest(".bozok-alert-badge,#bozok-alert-popover")) document.getElementById("bozok-alert-popover")?.remove();
    });
    new MutationObserver(() => { removeLegacyBridgeUi(); scheduleScan(); }).observe(document.body, { childList: true, subtree: true });
    refresh();
    setInterval(refresh, POLL_MS);
  }

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
