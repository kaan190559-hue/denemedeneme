(function () {
  "use strict";

  const MOON_TRANSACTIONS_URL = "https://moon-api.aypay.co/v1/transactions";
  const POLL_MS = 1000;
  const PROFILE_WINDOW_DAYS = 30;
  const PROFILE_REFRESH_MS = 120000;
  const PROFILE_MAX_PAGES = 10;
  const PROFILE_CACHE_KEY = "bozok-deposit-profiles-v2";
  const ALERT_STALE_GRACE_MS = 15000;
  const RECONCILE_MS = 500;
  let riskData = null;
  let profilesByUser = loadProfileCache();
  const profileRefreshes = new Map();
  let requestInFlight = false;
  let scanTimer = 0;
  let successfulRefreshes = 0;

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

  function textHasMoney(text, expected) {
    if (!expected || expected <= 0) return false;
    const matches = String(text || "").match(/₺\s*[\d.]+(?:,\d{1,2})?/g) || [];
    return matches.some(value => Math.abs(parseMoney(value) - expected) < 1);
  }

  function dateMs(source, keys) {
    for (const key of keys) {
      const parsed = Date.parse(valueByKey(source, [key]) || "");
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  function firstValue(...values) {
    return values.find(value => value !== undefined && value !== null && String(value).trim() !== "") || "";
  }

  function deepIdentifierValues(source) {
    const keys = [
      "_id", "id", "transactionId", "transactionID", "transactionNo", "transactionNumber",
      "processId", "processNo", "operationId", "operationNo", "requestId", "requestNo",
      "uuid", "referenceId", "referenceNo", "externalId", "paymentId", "depositId",
      "orderId", "siteTransactionId", "merchantTransactionId"
    ];
    const values = keys.map(key => valueByKey(source, [key]));
    const text = JSON.stringify(source || "");
    const inlineIds = String(text).match(/\b(?:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Z]{2,}[A-Z0-9-]{10,})\b/gi) || [];
    return [...values, ...inlineIds]
      .map(value => String(value || "").trim())
      .filter(value => value.length >= 6);
  }

  function compactTransaction(item = {}) {
    const bankAccount = item.bankAccount || item.account || item.assignedAccount || item.paymentAccount || {};
    const user = item.user || item.customer || item.member || {};
    const identifiers = deepIdentifierValues(item);
    return {
      id: identifiers[0] || "",
      identifiers: [...new Set(identifiers)],
      user: String(firstValue(
        typeof item.user === "string" ? item.user : "",
        user.fullName,
        user.name,
        item.userName,
        item.customerName,
        item.fullName,
        item.username,
        valueByKey(item, ["customerFullName", "memberName", "playerName"])
      )),
      userId: String(firstValue(
        typeof item.customerId === "string" ? item.customerId : "",
        typeof item.userId === "string" ? item.userId : "",
        user._id,
        user.id
      )),
      userUsername: String(firstValue(user.username, item.customerUsername, item.userName, item.username)),
      status: String(firstValue(item.status, item.state)),
      amount: parseMoney(firstValue(item.approvedAmount, item.confirmedAmount, item.finalAmount, item.processedAmount, item.amount, item.requestAmount)),
      requestedAt: String(firstValue(item.createdAt, item.requestDate, item.created_at, item.date)),
      completedAt: String(firstValue(item.completedAt, item.approvedAt, item.finishedAt, item.updatedAt)),
      bank: String(firstValue(
        item.bankName,
        typeof item.bank === "string" ? item.bank : "",
        item.bankTitle,
        bankAccount.bankName,
        typeof bankAccount.bank === "string" ? bankAccount.bank : "",
        bankAccount.bankTitle
      )),
      account: String(firstValue(
        typeof item.account === "string" ? item.account : "",
        item.accountName,
        item.accountHolderName,
        item.holderName,
        item.receiverName,
        item.senderName,
        bankAccount.accountName,
        bankAccount.name,
        bankAccount.accountHolderName,
        bankAccount.holderName,
        bankAccount.fullName
      ))
    };
  }

  function transactionOutcome(transaction) {
    const status = normalize(transaction?.status);
    if (/(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
      && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status)) return "approved";
    if (/(iptal|cancel|fail|failed|red|reject|rejected|error|basarisiz|declined)/.test(status)) return "failed";
    if (/(bekli|pending|waiting|atandi|assigned|isleniyor|processing|queued)/.test(status)) return "pending";
    return "other";
  }

  function profileTone(totalRequests, successRate, failedCount) {
    if (totalRequests < 3) return { level: "neutral", label: "AZ VERİ" };
    if (totalRequests >= 5 && successRate < 25 && failedCount >= 2) return { level: "risk", label: "SAHTE ŞÜPHESİ" };
    if (successRate >= 80) return { level: "trusted", label: "GÜVENİLİR" };
    if (successRate >= 60) return { level: "positive", label: "OLUMLU" };
    if (successRate >= 40) return { level: "suspicious", label: "ŞÜPHELİ" };
    return { level: "risk", label: "YÜKSEK RİSK" };
  }

  function buildProfiles(payload, now = Date.now()) {
    const cutoff = now - PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const profiles = new Map();
    const seen = new Set();
    for (const transaction of transactionArray(payload).map(compactTransaction)) {
      const userKey = normalize(transaction.user);
      const occurredAt = dateMs(transaction, ["completedAt", "requestedAt"]);
      if (!userKey || !occurredAt || occurredAt < cutoff || occurredAt > now + 60000) continue;
      const uniqueKey = transaction.id || `${userKey}|${transaction.requestedAt}|${transaction.amount}|${transaction.status}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);
      const profile = profiles.get(userKey) || {
        user: transaction.user,
        approvedCount: 0,
        failedCount: 0,
        pendingCount: 0,
        totalRequests: 0,
        approvedAmount: 0,
        lastRequestAt: "",
        lastApprovedAt: "",
        firstRequestAt: ""
      };
      const outcome = transactionOutcome(transaction);
      if (outcome === "other") continue;
      profile.totalRequests += 1;
      if (outcome === "approved") {
        profile.approvedCount += 1;
        profile.approvedAmount += Number(transaction.amount || 0);
        if (!profile.lastApprovedAt || occurredAt > Date.parse(profile.lastApprovedAt)) profile.lastApprovedAt = new Date(occurredAt).toISOString();
      } else if (outcome === "failed") profile.failedCount += 1;
      else profile.pendingCount += 1;
      if (!profile.lastRequestAt || occurredAt > Date.parse(profile.lastRequestAt)) profile.lastRequestAt = new Date(occurredAt).toISOString();
      if (!profile.firstRequestAt || occurredAt < Date.parse(profile.firstRequestAt)) profile.firstRequestAt = new Date(occurredAt).toISOString();
      profiles.set(userKey, profile);
    }
    for (const profile of profiles.values()) {
      profile.resolvedCount = profile.approvedCount + profile.failedCount;
      profile.successRate = profile.totalRequests ? Math.round((profile.approvedCount / profile.totalRequests) * 100) : 0;
      profile.resolvedSuccessRate = profile.resolvedCount ? Math.round((profile.approvedCount / profile.resolvedCount) * 100) : 0;
      profile.averageApprovedAmount = profile.approvedCount ? profile.approvedAmount / profile.approvedCount : 0;
      profile.updatedAt = new Date(now).toISOString();
      Object.assign(profile, profileTone(profile.totalRequests, profile.successRate, profile.failedCount));
    }
    return profiles;
  }

  function buildRisk(approvedPayload, activePayload) {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const approvedByUser = new Map();
    const activeByUser = new Map();
    const approvedIds = new Set();

    for (const transaction of transactionArray(approvedPayload).map(compactTransaction)) {
      const status = normalize(transaction.status);
      const userKey = normalize(transaction.user);
      if (!userKey) continue;
      const approved = /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
        && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);

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
      }
    }

    for (const transaction of transactionArray(activePayload).map(compactTransaction)) {
      const status = normalize(transaction.status);
      const userKey = normalize(transaction.user);
      if (!userKey || transaction.identifiers.some(identifier => approvedIds.has(identifier))) continue;
      const active = /(bekli|pending|atandi|assigned|isleniyor|processing)/.test(status);
      if (!active) continue;
      const list = activeByUser.get(userKey) || [];
      list.push({ transaction, requestedAt: dateMs(transaction, ["requestedAt"]) });
      activeByUser.set(userKey, list);
    }

    const result = { success: true, generatedAt: new Date(now).toISOString(), windowMinutes: 60, transactions: {}, approvedByUser: {} };
    for (const [userKey, approvals] of approvedByUser.entries()) result.approvedByUser[userKey] = approvals;
    const userKeys = new Set([...approvedByUser.keys(), ...activeByUser.keys()]);
    for (const userKey of userKeys) {
      const approvals = (approvedByUser.get(userKey) || []).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
      const active = (activeByUser.get(userKey) || []).sort((a, b) => (a.requestedAt || now) - (b.requestedAt || now));
      active.forEach((entry, index) => {
        const ordinal = approvals.length + index + 1;
        const profile = profilesByUser.get(userKey) || null;
        const alert = {
          id: entry.transaction.id,
          identifiers: entry.transaction.identifiers,
          user: entry.transaction.user,
          userId: entry.transaction.userId,
          userUsername: entry.transaction.userUsername,
          userKey,
          amount: entry.transaction.amount,
          bank: entry.transaction.bank,
          account: entry.transaction.account,
          ordinal,
          level: ordinal > 1 ? "repeat" : "first",
          label: ordinal > 1 ? `1 SAATTE ${ordinal}. TALEP` : "İLK TALEP · TEKRAR YOK",
          requestedAt: entry.requestedAt ? new Date(entry.requestedAt).toISOString() : "",
          previousApprovals: approvals,
          profile
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

  async function fetchMoonJson(status = "", page = 1, limit = 500, params = {}) {
    const url = new URL(MOON_TRANSACTIONS_URL);
    url.searchParams.set("type", "deposit");
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value));
    });
    url.searchParams.set("_", String(Date.now()));
    try {
      const response = await fetch(url, { credentials: "include", cache: "no-store", headers: { "Accept": "application/json, text/plain, */*" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch {
      return requestJson(url.toString());
    }
  }

  function localDate(value) {
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function sameUser(transaction, identity) {
    if (identity.userId && transaction.userId) return String(identity.userId) === String(transaction.userId);
    if (identity.userUsername && transaction.userUsername) return normalize(identity.userUsername) === normalize(transaction.userUsername);
    return normalize(identity.user) === normalize(transaction.user);
  }

  async function fetchMoonHistory(identity) {
    const now = Date.now();
    const cutoff = now - PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const params = {
      startDate: localDate(cutoff),
      endDate: localDate(now),
      dateField: "createdAt",
      customerId: identity.userId,
      customerUsername: identity.userId ? "" : identity.userUsername,
      customerName: identity.userId || identity.userUsername ? "" : identity.user
    };
    const transactions = [];
    const seen = new Set();
    let expectedPages = 1;
    for (let page = 1; page <= Math.min(expectedPages, PROFILE_MAX_PAGES); page += 1) {
      const payload = await fetchMoonJson("", page, 500, params);
      const items = transactionArray(payload);
      for (const item of items) {
        const transaction = compactTransaction(item);
        if (!sameUser(transaction, identity)) continue;
        const key = transaction.id || `${transaction.user}|${transaction.requestedAt}|${transaction.amount}|${transaction.status}`;
        if (!seen.has(key)) {
          seen.add(key);
          transactions.push(item);
        }
      }
      const pagination = payload?.data?.pagination || payload?.pagination || {};
      const total = Number(pagination.total || 0);
      const pageLimit = Number(pagination.limit || 500);
      expectedPages = Math.max(1, Number(pagination.pages || pagination.totalPages || 0) || (total ? Math.ceil(total / pageLimit) : 1));
      if (!items.length) break;
    }
    return { data: { transactions } };
  }

  function loadProfileCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
      return new Map(Object.entries(parsed).filter(([, profile]) => profile && typeof profile === "object"));
    } catch {
      return new Map();
    }
  }

  function saveProfileCache() {
    try { localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(Object.fromEntries(profilesByUser))); } catch { /* Storage is optional. */ }
  }

  function refreshProfile(identity) {
    const userKey = normalize(identity.user);
    if (!userKey) return null;
    const cached = profilesByUser.get(userKey);
    if (cached && Date.now() - Date.parse(cached.updatedAt || "") < PROFILE_REFRESH_MS) return null;
    if (profileRefreshes.has(userKey)) return profileRefreshes.get(userKey);
    const promise = fetchMoonHistory(identity)
      .then(payload => {
        const nextProfiles = buildProfiles(payload);
        const profile = nextProfiles.get(userKey) || {
          user: identity.user,
          approvedCount: 0,
          failedCount: 0,
          pendingCount: 0,
          totalRequests: 0,
          resolvedCount: 0,
          successRate: 0,
          resolvedSuccessRate: 0,
          approvedAmount: 0,
          averageApprovedAmount: 0,
          level: "neutral",
          label: "GEÇMİŞ YOK",
          updatedAt: new Date().toISOString()
        };
        profilesByUser.set(userKey, profile);
        saveProfileCache();
        Object.values(riskData?.transactions || {}).forEach(alert => {
          if (alert.userKey === userKey) alert.profile = profile;
        });
        scheduleScan();
      })
      .catch(() => {})
      .finally(() => { profileRefreshes.delete(userKey); });
    profileRefreshes.set(userKey, promise);
    return promise;
  }

  function refreshProfilesForRisk(risk) {
    const identities = new Map();
    Object.values(risk?.transactions || {}).forEach(alert => {
      if (!identities.has(alert.userKey)) identities.set(alert.userKey, {
        user: alert.user,
        userId: alert.userId,
        userUsername: alert.userUsername
      });
    });
    identities.forEach(identity => refreshProfile(identity));
  }

  function mergeRiskData(previous, next) {
    const now = Date.now();
    const transactions = {};
    for (const [key, alert] of Object.entries(next?.transactions || {})) {
      transactions[key] = { ...alert, confirmedAt: now };
    }
    for (const [key, alert] of Object.entries(previous?.transactions || {})) {
      if (transactions[key]) continue;
      const confirmedAt = Number(alert?.confirmedAt || Date.parse(previous?.generatedAt || "") || 0);
      if (confirmedAt && now - confirmedAt <= ALERT_STALE_GRACE_MS) transactions[key] = alert;
    }
    return { ...next, transactions };
  }

  function statusMatches(item, kind) {
    const status = normalize(compactTransaction(item).status);
    if (kind === "approved") {
      return /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
        && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);
    }
    return /(bekli|pending|waiting|atandi|assigned|isleniyor|processing|queued)/.test(status);
  }

  function filteredPayload(payload, kind) {
    return { data: { transactions: transactionArray(payload).filter(item => statusMatches(item, kind)) } };
  }

  function mergePayloads(...payloads) {
    const seen = new Set();
    const transactions = [];
    payloads.forEach(payload => {
      transactionArray(payload).forEach(item => {
        const compact = compactTransaction(item);
        const key = compact.id || `${normalize(compact.user)}|${compact.amount}|${compact.requestedAt}|${normalize(compact.status)}|${normalize(compact.account)}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        transactions.push(item);
      });
    });
    return { data: { transactions } };
  }

  function pageHasPendingTransaction() {
    return candidates().some(row => {
      const text = String(row.innerText || "");
      const hasPending = /bekliyor|atandı|atandi|işleniyor|isleniyor|pending|assigned/i.test(text);
      const hasIdentifier = /\b[a-f0-9]{24}\b/i.test(text) || /\b[A-Z0-9][A-Z0-9-]{11,}\b/.test(text);
      return hasPending && hasIdentifier;
    });
  }

  function rowLines(row) {
    return String(row?.innerText || "")
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean);
  }

  function isNoiseLine(line) {
    const normalized = normalize(line);
    return !line
      || /^new$/i.test(line)
      || /^site-/i.test(line)
      || /^tr\d{6,}/i.test(line.replace(/\s+/g, ""))
      || /bekliyor|atandi|atandı|isleniyor|işleniyor|pending|assigned/i.test(line)
      || /^\d{2}\.\d{2}\.\d{4}/.test(line)
      || /^[@#]/.test(line)
      || /^₺/.test(line)
      || normalized === "simsek";
  }

  function extractVisibleId(text) {
    const matches = String(text || "").match(/\b(?:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[A-Z]{2,}[A-Z0-9-]{10,})\b/gi) || [];
    return matches.find(value => !/^SITE-/i.test(value)) || "";
  }

  function parseVisibleDate(text) {
    const match = String(text || "").match(/\b(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\b/);
    if (!match) return "";
    const [, day, month, year, hour, minute, second = "00"] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
  }

  function compactVisibleRow(row) {
    const text = String(row?.innerText || "");
    if (!/bekliyor|atandı|atandi|işleniyor|isleniyor|pending|assigned/i.test(text)) return null;
    const lines = rowLines(row);
    const id = extractVisibleId(text);
    const amount = parseMoney((text.match(/₺\s*[\d.]+(?:,\d{1,2})?/) || [""])[0]);
    const deptIndex = lines.findIndex(line => normalize(line) === "simsek");
    const account = deptIndex >= 0 ? (lines[deptIndex + 1] || "") : "";
    const bank = deptIndex >= 0 ? (lines[deptIndex + 2] || "") : "";
    const handleIndex = lines.findIndex(line => /^@/.test(line));
    let user = handleIndex > 0 ? lines[handleIndex - 1] : "";
    if (!user) {
      user = lines.find(line => !isNoiseLine(line)
        && !/^SITE-/i.test(line)
        && line !== id
        && normalize(line) !== normalize(account)
        && normalize(line) !== normalize(bank)) || "";
    }
    const requestedAt = parseVisibleDate(text);
    if (!user || !amount) return null;
    return {
      id,
      identifiers: id ? [id] : [],
      user,
      userKey: normalize(user),
      amount,
      requestedAt,
      bank,
      account
    };
  }

  async function fetchMoonRisk() {
    const [approvedRaw, activeRaw, allPayload] = await Promise.all([
      fetchMoonJson("approved,completed,onaylandi,onaylandı,success,succeeded"),
      fetchMoonJson("pending,assigned"),
      fetchMoonJson("")
    ]);
    let approvedPayload = mergePayloads(approvedRaw, filteredPayload(allPayload, "approved"));
    let activePayload = mergePayloads(activeRaw, filteredPayload(allPayload, "active"));
    if (!approvedPayload || !activePayload) throw new Error("Moon talepleri eksik geldi");
    if (!transactionArray(approvedPayload).length) {
      approvedPayload = filteredPayload(allPayload, "approved");
    }
    if (!transactionArray(activePayload).length && pageHasPendingTransaction()) {
      activePayload = filteredPayload(allPayload, "active");
    }
    if (!transactionArray(activePayload).length && pageHasPendingTransaction()) {
      throw new Error("Ekranda talep var fakat Moon cevabında bulunamadı");
    }
    return buildRisk(approvedPayload, activePayload);
  }

  function installStyles() {
    if (document.getElementById("bozok-deposit-alert-styles")) return;
    const style = document.createElement("style");
    style.id = "bozok-deposit-alert-styles";
    style.textContent = `
      .bozok-alert-repeat{box-shadow:inset 3px 0 0 #d95f64!important;background-image:linear-gradient(90deg,rgba(217,95,100,.105),rgba(217,95,100,.045) 18%,transparent 46%)!important}
      .bozok-alert-first{box-shadow:inset 3px 0 0 #57c98d!important;background-image:linear-gradient(90deg,rgba(87,201,141,.09),rgba(87,201,141,.035) 18%,transparent 42%)!important}
      .bozok-alert-cluster{display:inline-flex!important;align-items:center;gap:6px;margin:4px 0 0 7px;vertical-align:middle;font:600 11px/1.25 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;cursor:pointer;user-select:none}
      .bozok-alert-dot{display:inline-block;width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 4px rgba(148,163,184,.08)}
      .bozok-alert-dot[data-level="repeat"]{background:#d95f64;box-shadow:0 0 0 4px rgba(217,95,100,.14)}
      .bozok-alert-dot[data-level="first"]{background:#57c98d;box-shadow:0 0 0 4px rgba(87,201,141,.14)}
      .bozok-alert-badge{display:inline-flex!important;align-items:center;min-height:20px;padding:2px 8px;border:1px solid transparent;border-radius:999px;font:700 10.5px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}
      .bozok-alert-badge[data-level="repeat"]{color:#ffd7da;background:rgba(109,31,38,.74);border-color:rgba(217,95,100,.72)}
      .bozok-alert-badge[data-level="first"]{color:#d7ffe8;background:rgba(24,84,55,.72);border-color:rgba(87,201,141,.68)}
      .bozok-profile{display:none!important}
      .bozok-profile[data-level="trusted"]{color:#d8ffe8;border-color:rgba(87,201,141,.64);background:rgba(24,84,55,.62)}
      .bozok-profile[data-level="positive"]{color:#efffc9;border-color:rgba(163,196,90,.58);background:rgba(66,82,35,.6)}
      .bozok-profile[data-level="suspicious"]{color:#ffecc2;border-color:rgba(219,168,62,.58);background:rgba(101,69,23,.58)}
      .bozok-profile[data-level="risk"]{color:#ffd8dc;border-color:rgba(217,95,100,.64);background:rgba(109,31,38,.62)}
      .bozok-alert-inline{display:none!important}
      .bozok-alert-repeat .bozok-alert-inline{color:#d9b4ba}.bozok-alert-first .bozok-alert-inline{color:#acd9c1}
      #bozok-alert-popover{position:fixed;z-index:2147483647;width:min(390px,calc(100vw - 24px));padding:15px;border:1px solid rgba(93,110,138,.66);border-radius:14px;background:#151922;color:#e4eaf4;box-shadow:0 24px 70px rgba(0,0,0,.5);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
      #bozok-alert-popover strong{display:block;margin-bottom:7px;color:#fff;font-size:14px}.bozok-alert-line{padding:8px 0;border-top:1px solid rgba(148,163,184,.16)}.bozok-alert-meta{color:#9eacc2;font-size:12px}
    `;
    document.head.appendChild(style);
  }

  function money(value) {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(Number(value || 0));
  }

  function compactMoney(value) {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 }).format(Number(value || 0));
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

  function shortTime(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
      : "";
  }

  function latestApproval(alert) {
    return [...(Array.isArray(alert.previousApprovals) ? alert.previousApprovals : [])]
      .sort((a, b) => Date.parse(b.completedAt || "") - Date.parse(a.completedAt || ""))[0] || null;
  }

  function minutesBeforeRequest(approval, alert) {
    const approvalMs = Date.parse(approval?.completedAt || "");
    const requestMs = Date.parse(alert?.requestedAt || "");
    if (!Number.isFinite(approvalMs) || !Number.isFinite(requestMs)) return "";
    const minutes = Math.max(0, Math.round((requestMs - approvalMs) / 60000));
    return `${minutes} dk önce`;
  }

  function alertBadgeText(alert) {
    return alert.level === "repeat" ? `${alert.ordinal || 2}. talep` : "güvenli";
  }

  function inlineSummary(alert, profile) {
    const approval = latestApproval(alert);
    if (alert.level === "repeat" && approval) {
      const when = shortTime(approval.completedAt);
      const delta = minutesBeforeRequest(approval, alert);
      const account = [approval.bank, approval.account].filter(Boolean).join(" / ");
      return [`Son onay ${when}`, delta, account].filter(Boolean).join(" · ");
    }
    if (profile) {
      return `30G ${profile.approvedCount}/${profile.totalRequests} onay · hacim ${compactMoney(profile.approvedAmount)}`;
    }
    return "30G profil hazırlanıyor";
  }

  function showPopover(alert, anchor) {
    document.getElementById("bozok-alert-popover")?.remove();
    const popover = document.createElement("div");
    popover.id = "bozok-alert-popover";
    const approvals = Array.isArray(alert.previousApprovals) ? alert.previousApprovals : [];
    const profile = alert.profile || profilesByUser.get(alert.userKey) || null;
    const profileLine = profile ? `
      <div class="bozok-alert-line"><b>30 günlük profil: ${escapeHtml(profile.label)} · %${profile.successRate}</b>
      <div class="bozok-alert-meta">${profile.approvedCount}/${profile.totalRequests} toplam talep onaylı · ${profile.failedCount} başarısız · ${profile.pendingCount} bekleyen</div>
      <div class="bozok-alert-meta">Sonuçlanan başarı %${profile.resolvedSuccessRate} · Onaylı hacim ${money(profile.approvedAmount)}</div>
      <div class="bozok-alert-meta">Ortalama onay ${money(profile.averageApprovedAmount)}${profile.lastApprovedAt ? ` · Son onay ${displayTime(profile.lastApprovedAt)}` : ""}</div></div>`
      : `<div class="bozok-alert-line"><b>30 günlük profil: Veri hazırlanıyor</b></div>`;
    const lines = approvals.length ? approvals.map((item, index) => `
      <div class="bozok-alert-line"><b>${index + 1}. onay: ${money(item.amount)}</b>
      <div class="bozok-alert-meta">${displayTime(item.completedAt)} · ${escapeHtml(item.bank || "Banka yok")}${item.account ? ` / ${escapeHtml(item.account)}` : ""}</div></div>`).join("")
      : `<div class="bozok-alert-line">Son 60 dakikada daha önce onaylanan yatırım yok.</div>`;
    popover.innerHTML = `<strong>${escapeHtml(alert.label)}</strong><div>${escapeHtml(alert.user || "Kullanıcı")}</div>${profileLine}${lines}`;
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
    const accountKey = normalize([alert.bank, alert.account].filter(Boolean).join(" "));
    const amount = Number(alert.amount || 0);
    let best = null;
    let bestScore = -Infinity;
    for (const row of rows) {
      if (used.has(row)) continue;
      const text = String(row.innerText || "");
      const normalizedText = normalize(text);
      const idMatch = identifiers.some(id => id.length >= 6 && text.includes(id));
      const userMatch = userKey && normalizedText.includes(userKey);
      const pendingMatch = /bekliyor|atandı|atandi|işleniyor|isleniyor|pending|assigned/i.test(text);
      const accountMatch = accountKey && accountKey.split(" ").filter(part => part.length >= 3).some(part => normalizedText.includes(part));
      const amountMatch = textHasMoney(text, amount);
      const softMatch = userMatch && pendingMatch && (amountMatch || accountMatch);
      if (!idMatch && !softMatch) continue;
      const score = (idMatch ? 10000 : 0) + (userMatch ? 1200 : 0) + (amountMatch ? 700 : 0) + (accountMatch ? 350 : 0) + (pendingMatch ? 200 : 0) - text.length - row.getBoundingClientRect().height;
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

  function visibleFallbackAlerts(rows, existingAlerts) {
    const result = [];
    const seen = new Set(existingAlerts.map(alert => String(alert.id || `${alert.userKey}-${alert.requestedAt}-${alert.amount}`)));
    const pendingByUser = new Map();
    for (const row of rows) {
      const transaction = compactVisibleRow(row);
      if (!transaction) continue;
      const apiMatch = existingAlerts.some(alert => {
        const ids = [...new Set([alert.id, ...(alert.identifiers || [])].filter(Boolean).map(String))];
        const rowText = String(row.innerText || "");
        if (ids.some(id => id.length >= 6 && rowText.includes(id))) return true;
        return alert.userKey === transaction.userKey
          && Math.abs(Number(alert.amount || 0) - transaction.amount) < 1
          && normalize(alert.account || "") === normalize(transaction.account || "");
      });
      if (apiMatch) continue;
      const key = transaction.id || `${transaction.userKey}-${transaction.amount}-${transaction.requestedAt}-${normalize(transaction.account)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const approvals = riskData?.approvedByUser?.[transaction.userKey] || [];
      const previousPending = pendingByUser.get(transaction.userKey) || 0;
      pendingByUser.set(transaction.userKey, previousPending + 1);
      const ordinal = approvals.length + previousPending + 1;
      result.push({
        ...transaction,
        ordinal,
        level: ordinal > 1 ? "repeat" : "first",
        label: ordinal > 1 ? `1 SAATTE ${ordinal}. TALEP` : "İLK TALEP · TEKRAR YOK",
        previousApprovals: approvals,
        profile: profilesByUser.get(transaction.userKey) || null,
        fromVisibleRow: true
      });
    }
    return result;
  }

  function applyAlerts() {
    const rows = candidates();
    const apiAlerts = [...new Map(Object.values(riskData?.transactions || {}).map(alert => [alert.id || `${alert.userKey}-${alert.requestedAt}`, alert])).values()];
    const alerts = [...apiAlerts, ...visibleFallbackAlerts(rows, apiAlerts)];
    const used = new Set();
    const active = new Set();
    for (const alert of alerts) {
      const row = findRow(alert, rows, used);
      if (!row) continue;
      used.add(row);
      const key = String(alert.id || `${alert.userKey}-${alert.requestedAt}`);
      active.add(key);
      row.dataset.bozokAlertRow = key;
      delete row.dataset.bozokAlertMissingSince;
      row.querySelectorAll(".bozok-alert-cluster,.bozok-alert-badge,.bozok-profile").forEach(item => {
        if (item.dataset.alertKey !== key) item.remove();
      });
      row.classList.toggle("bozok-alert-repeat", alert.level === "repeat");
      row.classList.toggle("bozok-alert-first", alert.level !== "repeat");
      let cluster = [...row.querySelectorAll(".bozok-alert-cluster")].find(item => item.dataset.alertKey === key);
      if (!cluster) {
        cluster = document.createElement("span");
        cluster.className = "bozok-alert-cluster";
        cluster.dataset.alertKey = key;
        cluster.innerHTML = `
          <span class="bozok-alert-dot"></span>
          <span class="bozok-alert-badge"></span>
        `;
        badgeHost(row, alert).appendChild(cluster);
      }
      cluster.dataset.level = alert.level;
      const dot = cluster.querySelector(".bozok-alert-dot");
      const badge = cluster.querySelector(".bozok-alert-badge");
      dot.dataset.level = alert.level;
      badge.dataset.level = alert.level;
      badge.textContent = alertBadgeText(alert);
      cluster.onclick = event => { event.preventDefault(); event.stopPropagation(); showPopover(alert, cluster); };
    }
    document.querySelectorAll("[data-bozok-alert-row]").forEach(row => {
      const rowKey = row.dataset.bozokAlertRow;
      const text = String(row.innerText || "");
      const currentAlert = alerts.find(alert => String(alert.id || `${alert.userKey}-${alert.requestedAt}`) === rowKey);
      const identifiers = [...new Set([currentAlert?.id, ...(currentAlert?.identifiers || [])].filter(Boolean).map(String))];
      const stillMatches = currentAlert && (identifiers.length
        ? identifiers.some(identifier => identifier.length >= 6 && text.includes(identifier))
        : normalize(text).includes(currentAlert.userKey));
      if (active.has(rowKey) && stillMatches) return;
      row.classList.remove("bozok-alert-repeat", "bozok-alert-first");
      row.querySelectorAll(".bozok-alert-cluster,.bozok-alert-badge,.bozok-profile").forEach(badge => badge.remove());
      delete row.dataset.bozokAlertRow;
      delete row.dataset.bozokAlertMissingSince;
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
      const nextRisk = await fetchMoonRisk();
      if (!nextRisk?.success || !nextRisk.generatedAt || !nextRisk.transactions) throw new Error("Moon özeti doğrulanamadı");
      riskData = mergeRiskData(riskData, nextRisk);
      refreshProfilesForRisk(riskData);
      successfulRefreshes += 1;
    } catch {
      // Last known-good alerts stay visible during transient API failures.
    } finally {
      requestInFlight = false;
      if (successfulRefreshes || riskData) scheduleScan();
    }
  }

  function removeLegacyBridgeUi() {
    document.querySelectorAll("button").forEach(button => {
      const text = String(button.textContent || "").trim();
      const style = getComputedStyle(button);
      if (style.position === "fixed" && (text === "Render" || text === "Canlı" || text === "Bekliyor" || /^Aktif:/.test(text))) button.remove();
    });
  }

  function removeLegacyRiskUi() {
    document.getElementById("bozok-risk-popover")?.remove();
    document.querySelectorAll(".bozok-risk-badge").forEach(item => item.remove());
    document.querySelectorAll(".bozok-risk-row-repeat,.bozok-risk-row-first").forEach(row => {
      row.classList.remove("bozok-risk-row-repeat", "bozok-risk-row-first");
      delete row.dataset.bozokRiskRow;
    });
  }

  function start() {
    installStyles();
    removeLegacyBridgeUi();
    removeLegacyRiskUi();
    document.addEventListener("click", event => {
      if (!event.target.closest(".bozok-alert-cluster,#bozok-alert-popover")) document.getElementById("bozok-alert-popover")?.remove();
    });
    new MutationObserver(() => { removeLegacyBridgeUi(); removeLegacyRiskUi(); scheduleScan(); }).observe(document.body, { childList: true, subtree: true });
    refresh();
    setInterval(refresh, POLL_MS);
    setInterval(scheduleScan, RECONCILE_MS);
  }

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
