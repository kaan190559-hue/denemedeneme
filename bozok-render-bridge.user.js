// ==UserScript==
// @name         Bozok Moon Köprüsü
// @namespace    https://github.com/kaan190559-hue/denemedeneme
// @version      1.7.3
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
    WD_REFRESH_MS: 30000,
    FETCH_TIMEOUT_MS: 12000,
    POST_TIMEOUT_MS: 60000,
    DEVICE_KEY: "bozokRenderBridgeDevice",
    RENDER_KEY: "bozokRenderBridgeUrl",
    DAY_TX_KEY: "bozokDayTx"
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
  let lastWithdrawalItems = [];
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

  function istanbulDate(value) {
    if (value === undefined || value === null || value === "") {
      return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
    }
    const raw = String(value).trim();
    const trDate = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (trDate) return `${trDate[3]}-${trDate[2]}-${trDate[1]}`;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
    }
    return raw.slice(0, 10);
  }

  function sameIstanbulDay(value, day = istanbulDate()) {
    const stamp = istanbulDate(value);
    return !stamp || stamp === day;
  }

  function loadDayStore() {
    const today = istanbulDate();
    const saved = GM_getValue(CONFIG.DAY_TX_KEY, null);
    if (!saved || saved.date !== today || typeof saved !== "object") {
      return { date: today, deposits: {}, partials: {}, txOk: {} };
    }
    return {
      date: today,
      deposits: saved.deposits && typeof saved.deposits === "object" ? saved.deposits : {},
      partials: saved.partials && typeof saved.partials === "object" ? saved.partials : {},
      txOk: saved.txOk && typeof saved.txOk === "object" ? saved.txOk : {}
    };
  }

  function saveDayStore(store) {
    GM_setValue(CONFIG.DAY_TX_KEY, store);
  }

  function pickFirst(...values) {
    return values.find(value => value !== undefined && value !== null && String(value).trim() !== "") || "";
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function transactionIdOf(item = {}) {
    const nested = asObject(item.transaction) || asObject(item.data) || asObject(item.payload) || {};
    return String(pickFirst(
      item._id,
      item.id,
      item.uuid,
      item.transactionId,
      item.transaction_id,
      item.requestId,
      item.operationId,
      nested._id,
      nested.id,
      nested.uuid,
      nested.transactionId
    ) || "").trim();
  }

  function latestEventTime(...values) {
    let best = 0;
    let raw = "";
    for (const value of values) {
      const parsed = Date.parse(value || "");
      if (Number.isFinite(parsed) && parsed > best) {
        best = parsed;
        raw = String(value);
      }
    }
    return { ms: best, raw };
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

  function ledgerStamp(value) {
    return String(value || "")
      .toLocaleLowerCase("tr-TR")
      .replace(/[^a-z0-9]+/g, "");
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

  function looksLikeBankName(value) {
    const n = ledgerStamp(value);
    return /(bank|kredi|papara|enpara|havale)/.test(n);
  }

  function nestedPaymentLists(raw) {
    if (!raw || typeof raw !== "object") return [];
    const keys = [
      "payments",
      "partialPayments",
      "parts",
      "splits",
      "assignments",
      "assignedAccounts",
      "accounts",
      "bankAccounts",
      "accountPayments"
    ];
    const found = [];
    for (const key of keys) {
      const list = raw[key];
      if (Array.isArray(list)) {
        found.push(...list.filter(item => item && typeof item === "object"));
      }
    }
    return found;
  }

  function compactAccount(item = {}) {
    const bankAccount = asObject(item.accountSnapshot)
      || asObject(item.bankAccountSnapshot)
      || asObject(item.bankAccount)
      || asObject(item.assignedAccount)
      || asObject(item.paymentAccount)
      || {};
    const bankObj = asObject(item.bankId) || asObject(item.bank) || {};
    const setSnap = asObject(item.setSnapshot) || {};
    const bankSnap = asObject(item.bankSnapshot) || {};
    const bank = String(pickFirst(
      bankAccount.bankName,
      bankSnap.name,
      item.bankName,
      typeof item.bank === "string" ? item.bank : "",
      item.bankTitle,
      bankObj.name,
      typeof bankAccount.bank === "string" ? bankAccount.bank : "",
      bankAccount.bankTitle
    )).trim();
    const userObj = asObject(item.user) || asObject(item.customer) || asObject(item.member) || {};
    const identifiers = [
      transactionIdOf(item),
      item.processId,
      item.paymentId,
      item.partId
    ]
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
      account: (() => {
        const userName = String(pickFirst(
          typeof item.user === "string" ? item.user : "",
          userObj.fullName,
          userObj.name,
          item.userName,
          item.customerName,
          item.fullName,
          item.playerName,
          item.senderName
        )).trim();
        const setName = String(pickFirst(
          bankAccount.setName,
          setSnap.name,
          item.setName,
          item.accountHolderName,
          item.holderName,
          typeof item.accountName === "string" && !looksLikeBankName(item.accountName) ? item.accountName : "",
          item.displayName,
          typeof item.name === "string" && !looksLikeBankName(item.name) ? item.name : "",
          bankAccount.accountName,
          bankAccount.accountHolderName,
          bankAccount.holderName,
          bankAccount.displayName,
          typeof bankAccount.name === "string" && !looksLikeBankName(bankAccount.name) ? bankAccount.name : ""
        )).trim();
        if (setName && userName && ledgerStamp(setName) === ledgerStamp(userName)) {
          const ownSet = String(pickFirst(item.setName, bankAccount.setName, bankAccount.accountHolderName)).trim();
          return ownSet && ledgerStamp(ownSet) !== ledgerStamp(userName) ? ownSet : "";
        }
        return setName;
      })(),
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
      completedAt: latestEventTime(
        item.completedAt,
        item.approvedAt,
        item.finishedAt,
        item.processedAt,
        item.receiptApprovedAt
      ).raw || String(pickFirst(item.completedAt, item.approvedAt, item.updatedAt) || ""),
      date: String(pickFirst(item.createdAt, item.requestDate, item.date, item.completedAt) || "").slice(0, 10)
    };
  }

  function moonTxRoot(payload) {
    const data = asObject(payload?.data);
    if (data && (Array.isArray(data.partialPayments) || data.type || data.amount)) return data;
    return asObject(payload) || {};
  }

  function extractOfficialPartials(payload, parent = {}) {
    const root = moonTxRoot(payload);
    const data = payload?.data;
    const groups = Array.isArray(root.partialPayments)
      ? root.partialPayments
      : Array.isArray(data) && data.some(item => item && (item.payments || item.accountSnapshot))
        ? data
        : Array.isArray(payload) && payload.some(item => item && (item.payments || item.accountSnapshot))
          ? payload
          : [];
    const customer = String(pickFirst(asObject(root.customer)?.name, parent.user) || "").trim();
    const found = [];
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      if (group.status && !isPayoutLike(group.status)) continue;
      const inners = Array.isArray(group.payments) && group.payments.length ? group.payments : [group];
      for (const pay of inners) {
        if (!pay || typeof pay !== "object") continue;
        const snap = asObject(pay.accountSnapshot) || asObject(group.accountSnapshot) || {};
        const bank = String(pickFirst(
          snap.bankName,
          asObject(pay.bankId)?.name,
          asObject(group.bankId)?.name
        ) || "").trim();
        const account = String(pickFirst(snap.setName, pay.setName, group.setName) || "").trim();
        const amount = parseMoney(pickFirst(pay.amount, group.amount));
        if (!(amount > 0) || !bank || !account) continue;
        found.push({
          id: String(pay._id || group._id || ""),
          amount,
          bank,
          account,
          status: String(group.status || pay.status || "completed"),
          user: customer,
          completedAt: String(group.completedAt || pay.completedAt || root.completedAt || parent.completedAt || ""),
          date: String(group.completedAt || root.completedAt || "").slice(0, 10)
        });
      }
    }
    return found;
  }

  function paymentArrays(payload) {
    const found = [];
    const candidates = [
      payload?.partialPayments,
      payload?.payments,
      payload?.parts,
      payload?.splits,
      payload?.assignments,
      payload?.assignedAccounts,
      payload?.data?.partialPayments,
      payload?.data?.payments,
      payload?.data?.parts,
      payload?.data?.splits,
      payload?.data?.items
    ];
    if (Array.isArray(payload?.data)) candidates.push(payload.data);
    for (const list of candidates) {
      if (Array.isArray(list) && list.length) found.push(...list);
    }
    if (Array.isArray(payload) && payload.length && payload[0] && typeof payload[0] === "object") {
      found.push(...payload);
    }
    return found;
  }

  function isPayoutLike(value) {
    const status = normalizeStatus(value);
    if (!status) return true;
    return !/(iptal|cancel|fail|red|reject|error|basarisiz|declined)/.test(status);
  }

  function accountStamp(item) {
    return `${ledgerStamp(item.bank)}:${ledgerStamp(item.account)}`;
  }

  function finalizePayments(extracted, parent) {
    const named = (extracted || []).filter(item => item.amount > 0 && item.bank && item.account);
    const unnamedSplits = (extracted || []).filter(item => {
      if (!(item.amount > 0) || (item.bank && item.account)) return false;
      return !parent.amount || Math.abs(item.amount - parent.amount) > 1;
    });
    const accounts = new Set(named.map(accountStamp));
    if (accounts.size >= 2) {
      const splits = parent.amount > 0
        ? named.filter(item => Math.abs(item.amount - parent.amount) > 1)
        : named;
      return splits.length ? splits : named;
    }
    if (unnamedSplits.length >= 2) return [];
    if (named.length === 1) return named;
    if (named.length > 1) {
      const splits = parent.amount > 0
        ? named.filter(item => Math.abs(item.amount - parent.amount) > 1)
        : named;
      return splits.length ? splits : named.slice(0, 1);
    }
    if (parent.amount > 50000) return [];
    if (parent.amount > 0 && parent.bank && parent.account) return [parent];
    return [];
  }

  function extractPartialPayments(payload, parent = {}) {
    const keyHint = /(partial|parc|split|payment|odeme|assignment|assigned)/i;
    const nodes = [];
    const seen = new Set();
    const walk = (value, key = "", depth = 0) => {
      if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        if (keyHint.test(key) || /^(data|items|results)$/i.test(key)) {
          value.forEach(item => {
            if (item && typeof item === "object") nodes.push(item);
          });
        }
        return;
      }
      for (const [childKey, child] of Object.entries(value)) {
        if (!child || typeof child !== "object") continue;
        if (/attachment|callback|statusHistory|forensic|metadata|requestBody|responseBody|requestHeaders/i.test(childKey)) continue;
        if (depth === 0 || keyHint.test(childKey) || /^(data|payload|result)$/i.test(childKey)) {
          walk(child, childKey, depth + 1);
        }
      }
    };
    walk(payload);
    for (const raw of paymentArrays(payload)) {
      if (raw && typeof raw === "object") nodes.push(raw);
    }

    const expanded = [];
    for (const raw of nodes) {
      if (Array.isArray(raw.payments) && raw.payments.length) {
        expanded.push(...raw.payments);
        continue;
      }
      const kids = nestedPaymentLists(raw);
      const namedKids = kids.filter(child => {
        const compact = compactAccount(child);
        return compact.amount > 0 && (compact.bank || compact.account);
      });
      if (namedKids.length >= 2) {
        expanded.push(...namedKids);
        continue;
      }
      expanded.push(raw);
    }

    const unique = [];
    const keys = new Set();
    for (const raw of expanded) {
      const compact = compactAccount(raw);
      if (!(compact.amount > 0)) continue;
      const sameAsParent = parent.id && compact.id && compact.id === parent.id
        && parent.amount > 0 && Math.abs(compact.amount - parent.amount) < 1;
      if (sameAsParent) continue;
      if (parent.user && compact.account && ledgerStamp(compact.account) === ledgerStamp(parent.user)) {
        compact.account = "";
      }
      const stamp = [compact.id, compact.bank, compact.account, Math.round(compact.amount)].join("|");
      if (keys.has(stamp)) continue;
      keys.add(stamp);
      unique.push({
        ...compact,
        user: compact.user || parent.user || ""
      });
    }
    return unique;
  }

  async function paymentsForWithdrawal(item) {
    const parent = compactAccount(item);
    const id = transactionIdOf(item) || parent.id;
    if (!id || id === "undefined") {
      return finalizePayments(extractPartialPayments(item, parent), parent);
    }
    const cached = partialCache.get(id);
    if (cached && cached.payments.length && Date.now() - cached.at < CONFIG.WD_REFRESH_MS) {
      return cached.payments;
    }

    let extracted = extractOfficialPartials(item, parent);
    if (!extracted.length) extracted = extractPartialPayments(item, parent);
    const urls = [
      `https://moon-api.aypay.co/v1/transactions/${encodeURIComponent(id)}`,
      `https://moon-api.aypay.co/v1/transactions/${encodeURIComponent(id)}/partial-payments`
    ];
    for (const url of urls) {
      try {
        const payload = await moonGet(url);
        const official = extractOfficialPartials(payload, parent);
        if (official.length) {
          extracted = official;
          break;
        }
        const next = extractPartialPayments(payload, parent);
        if (next.length > extracted.length) extracted = next;
        const accounts = new Set(extracted.filter(row => row.bank && row.account).map(accountStamp));
        if (accounts.size >= 2) break;
      } catch (error) {
        console.warn("[Bozok kasa] parçalı ödeme", id, error);
      }
    }

    const payments = finalizePayments(extracted, parent).map(row => ({
      ...row,
      user: row.user || parent.user || ""
    }));
    const stamps = new Set(payments.filter(row => row.bank && row.account).map(accountStamp));
    if (stamps.size >= 2) {
      console.info("[Bozok kasa] parçalı çekim", parent.user || id, payments.map(p => ({
        kisi: p.user || parent.user || "",
        kasa: p.account,
        banka: p.bank,
        tutar: p.amount
      })));
    }
    if (payments.length) {
      if (partialCache.size > 80) partialCache.clear();
      partialCache.set(id, { at: Date.now(), payments });
    }
    return payments;
  }

  async function moonGet(url) {
    const response = await fetchWithTimeout(url, moonFetchOptions(), CONFIG.FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Moon ${response.status}`);
    return response.json();
  }

  async function fetchTodayTransactions(type, status, maxPages = 6) {
    const today = istanbulDate();
    const all = [];
    const seen = new Set();
    for (let page = 1; page <= maxPages; page += 1) {
      const payload = await moonGet(txUrl(type, status, page, 80));
      const list = transactionArray(payload);
      if (!list.length) break;
      let older = 0;
      for (const raw of list) {
        const item = compactAccount(raw);
        if (!item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        const day = istanbulDate(item.completedAt || item.date || raw.completedAt || raw.createdAt);
        if (day && day < today) {
          older += 1;
          continue;
        }
        if (!day || day === today) all.push(raw);
      }
      if (older === list.length) break;
    }
    return all;
  }

  function isFreshLedgerItem(item) {
    const at = latestEventTime(
      item?.completedAt,
      item?.approvedAt,
      item?.finishedAt,
      item?.processedAt,
      item?.receiptApprovedAt
    ).ms;
    if (at) return Date.now() - at < 45 * 60 * 1000;
    return true;
  }

  async function collectDepositEvents() {
    const store = loadDayStore();
    const seen = new Set(Object.keys(store.deposits || {}));
    try {
      for (const status of ["approved", "completed", ""]) {
        const raws = await fetchTodayTransactions("deposit", status);
        for (const raw of raws) {
          const item = compactAccount(raw);
          if (!item.id || !(item.amount > 0)) continue;
          if (item.status && !isApproved(item.status) && status !== "approved") continue;
          if (!item.bank || !item.account) continue;
          store.deposits[item.id] = item;
          seen.add(item.id);
        }
      }
      saveDayStore(store);
    } catch (error) {
      console.warn("[Bozok kasa] yatırım listesi", error);
    }
    lastDepositItems = Object.values(store.deposits);
    return lastDepositItems
      .filter(isFreshLedgerItem)
      .map(item => ({
        ledgerKey: `dep:${item.id}`,
        amount: item.amount,
        bank: item.bank,
        account: item.account,
        completedAt: item.completedAt,
        kind: "deposit"
      }));
  }

  async function collectWithdrawalEvents() {
    const store = loadDayStore();
    lastPartialItems = Object.values(store.partials);
    if (Date.now() - lastWithdrawalAt < CONFIG.WD_REFRESH_MS && lastWithdrawalEvents.length) {
      return lastWithdrawalEvents;
    }
    let list = [];
    try {
      list = (await fetchTodayTransactions("withdrawal", "", 8))
        .filter(item => compactAccount(item).id);
      lastWithdrawalItems = list.map(compactAccount);
    } catch (error) {
      console.warn("[Bozok kasa] çekim listesi", error);
      return lastWithdrawalEvents;
    }
    const events = [];
    const pending = list.filter(raw => !store.txOk[compactAccount(raw).id]);
    const queue = [...pending.slice(0, 12), ...list.filter(raw => store.txOk[compactAccount(raw).id]).slice(0, 4)];
    const seenTx = new Set();
    for (const raw of queue) {
      const item = compactAccount(raw);
      if (!item.id || seenTx.has(item.id)) continue;
      seenTx.add(item.id);
      const payments = await paymentsForWithdrawal(raw);
      if (payments.length) store.txOk[item.id] = true;
      for (const payment of payments) {
        if (payment.status && !isPayoutLike(payment.status)) continue;
        const amount = Math.abs(Number(payment.amount || 0));
        const bank = String(payment.bank || "").trim();
        const account = String(payment.account || "").trim();
        const id = String(payment.id || [item.id, bank, account, Math.round(amount)].filter(Boolean).join(":"));
        if (!id || !(amount > 0) || !bank || !account) continue;
        const row = {
          id,
          transactionId: item.id,
          amount,
          bank,
          account,
          status: payment.status || "approved",
          user: payment.user || item.user || "",
          completedAt: payment.completedAt || item.completedAt || "",
          date: istanbulDate(payment.completedAt || item.completedAt)
        };
        store.partials[`${item.id}:${id}`] = row;
        if (isFreshLedgerItem(row)) {
          events.push({
            ledgerKey: `wd:${item.id}:${id}:${ledgerStamp(bank)}:${ledgerStamp(account)}:${Math.round(amount)}`,
            amount: -amount,
            bank,
            account,
            completedAt: row.completedAt,
            kind: "withdrawal"
          });
        }
      }
    }
    saveDayStore(store);
    lastWithdrawalAt = Date.now();
    lastWithdrawalEvents = events.length ? events : lastWithdrawalEvents;
    lastPartialItems = Object.values(store.partials);
    lastWithdrawalItems = list.map(compactAccount);
    console.info("[Bozok kasa] çekim özeti", {
      adet: lastPartialItems.length,
      yeni: events.length
    });
    return lastWithdrawalEvents;
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
        console.warn("[Bozok kasa] panelde bulunamayan kasa", lastLedgerSummary, result.unmatchedSamples);
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
    const store = loadDayStore();
    const storedDeposits = Object.values(store.deposits);
    const storedPartials = Object.values(store.partials);
    if (storedDeposits.length) lastDepositItems = storedDeposits;
    if (storedPartials.length) lastPartialItems = storedPartials;
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
          withdrawals: { data: { transactions: lastWithdrawalItems } },
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
      syncLedger();
      if (result.skipped && !result.accepted) {
        setStatus(`Atlandı: ${result.currentDeviceName || "başka cihaz"} | kasa gidiyor`, "idle");
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

  function startKeepAliveWorker() {
    try {
      const blob = new Blob([
        "setInterval(function(){postMessage('tick');},4000);"
      ], { type: "text/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = () => {
        resumeBackgroundAudio();
        syncLedger();
        if (document.hidden) syncOnce();
      };
    } catch (error) {
      console.warn("[Bozok köprü] worker başlatılamadı", error);
    }
  }

  function schedulePoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      resumeBackgroundAudio();
      syncOnce();
    }, CONFIG.POLL_MS);
    if (ledgerTimer) clearInterval(ledgerTimer);
    ledgerTimer = setInterval(() => {
      resumeBackgroundAudio();
      syncLedger();
    }, CONFIG.LEDGER_MS);
    startKeepAliveWorker();
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
      syncOnce();
      syncLedger();
    });
    window.addEventListener("focus", () => {
      resumeBackgroundAudio();
      syncOnce();
      syncLedger();
    });
    document.addEventListener("click", resumeBackgroundAudio, { capture: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
