const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = __dirname;
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, ".playwright-browsers");
}

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const envPath = path.join(root, ".env");
const moonApiUrl = "https://moon-api.aypay.co/v1/departments/with-balances?page=1&limit=500";
const moonTransactionsUrl = "https://moon-api.aypay.co/v1/transactions";
const moonApiBaseUrl = "https://moon-api.aypay.co";
const moonLoginUrl = "https://moon.aypay.co/login";
const moonHomeUrl = "https://moon.aypay.co/departments";

const status = {
  enabled: false,
  running: false,
  source: "playwright",
  lastLoginAt: "",
  lastFetchAt: "",
  lastFetchTransport: "",
  lastPushAt: "",
  lastAcceptedAt: "",
  lastSkippedAt: "",
  lastSuccessAt: "",
  lastPayloadCapturedAt: "",
  lastHeartbeatAt: "",
  lastRestartAt: "",
  lastRestartReason: "",
  lastError: "",
  lastDepositRefreshAt: "",
  lastDepositRefreshStatus: "idle",
  lastDepositRefreshError: "",
  lastDepositPagesFetched: 0,
  lastDepositCount: 0,
  lastDepositTotal: 0,
  depositBackgroundEnabled: false,
  depositBackgroundRefreshMs: 0,
  depositBackgroundMaxPages: 0,
  nextDepositRefreshAt: "",
  codeVersion: "deposit-bg-v2",
  lastCycleMs: 0,
  seq: 0,
  consecutiveErrors: 0,
  restartCount: 0,
  health: "idle",
  deviceName: "",
  nextRunAt: "",
  browser: ""
};

let singleton = null;

function readPreviousMoonLive() {
  try {
    const recordPath = path.join(root, "moon-cache.json");
    if (!fs.existsSync(recordPath)) return null;
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return record?.payload?.bozokLive || null;
  } catch {
    return null;
  }
}

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on", "evet"].includes(value);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emptyTransactionBundle() {
  return {
    deposits: { data: { transactions: [] }, count: 0, total: 0 },
    withdrawals: { data: { transactions: [] }, count: 0, total: 0 },
    activeDeposits: { data: { transactions: [] }, count: 0, total: 0 },
    activeWithdrawals: { data: { transactions: [] }, count: 0, total: 0 },
    withdrawalPartials: { source: "not-ready", count: 0, payments: [] }
  };
}

function stableTransactionBundle(bundle) {
  const transactions = bundle || emptyTransactionBundle();
  return {
    deposits: transactions.deposits || { data: { transactions: [] }, count: 0, total: 0 },
    withdrawals: transactions.withdrawals || { data: { transactions: [] }, count: 0, total: 0 },
    activeDeposits: transactions.activeDeposits || { data: { transactions: [] }, count: 0, total: 0 },
    activeWithdrawals: transactions.activeWithdrawals || { data: { transactions: [] }, count: 0, total: 0 },
    withdrawalPartials: transactions.withdrawalPartials || { source: "not-ready", count: 0, payments: [] }
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function slimTransactionGroup(group, limit = 120) {
  const source = group || { data: { transactions: [] }, count: 0, total: 0 };
  const transactions = transactionArray(source);
  const safeLimit = Math.max(0, Number(limit) || 0);
  const data = source.data && typeof source.data === "object" && !Array.isArray(source.data)
    ? { ...source.data }
    : {};
  data.transactions = transactions.slice(0, safeLimit);
  return {
    ...cloneJson(source),
    data,
    count: Number(source.count ?? transactions.length) || transactions.length,
    total: Number(source.total ?? transactions.reduce((sum, item) => sum + (Number(item?.amount) || 0), 0)) || 0,
    sampleCount: Math.min(transactions.length, safeLimit),
    originalCount: Number(source.count ?? transactions.length) || transactions.length,
    slimmed: transactions.length > safeLimit
  };
}

function slimWithdrawalPartials(group, limit = 250) {
  const source = group || { source: "not-ready", count: 0, payments: [] };
  const payments = Array.isArray(source.payments)
    ? source.payments
    : Array.isArray(source.data?.payments)
      ? source.data.payments
      : [];
  const safeLimit = Math.max(0, Number(limit) || 0);
  return {
    ...cloneJson(source),
    payments: payments.slice(0, safeLimit),
    count: Number(source.count ?? payments.length) || payments.length,
    sampleCount: Math.min(payments.length, safeLimit),
    originalCount: Number(source.count ?? payments.length) || payments.length,
    slimmed: payments.length > safeLimit
  };
}

function slimTransactionBundle(bundle) {
  const transactions = stableTransactionBundle(bundle);
  const listLimit = numberEnv("MOON_LIVE_TRANSACTION_SAMPLE_LIMIT", 120);
  const partialLimit = numberEnv("MOON_LIVE_PARTIAL_SAMPLE_LIMIT", 250);
  return {
    deposits: slimTransactionGroup(transactions.deposits, listLimit),
    withdrawals: slimTransactionGroup(transactions.withdrawals, listLimit),
    activeDeposits: slimTransactionGroup(transactions.activeDeposits, listLimit),
    activeWithdrawals: slimTransactionGroup(transactions.activeWithdrawals, listLimit),
    withdrawalPartials: slimWithdrawalPartials(transactions.withdrawalPartials, partialLimit)
  };
}

function pickFirst(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function transactionArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function accountArray(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data?.bankAccounts,
    payload?.data?.accounts,
    payload?.data?.paymentAccounts,
    payload?.data?.records,
    payload?.data?.items,
    payload?.data?.results,
    payload?.bankAccounts,
    payload?.accounts,
    payload?.paymentAccounts,
    payload?.records,
    payload?.items,
    payload?.results,
    payload?.data
  ];
  const direct = candidates.find(Array.isArray);
  if (direct) return direct;
  return [];
}

function objectValueByKey(source, keys) {
  if (!source || typeof source !== "object") return "";
  const normalizedKeys = keys.map(key => String(key).toLowerCase());
  const queue = [source];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, value] of Object.entries(current)) {
      if (normalizedKeys.includes(key.toLowerCase()) && value !== undefined && value !== null && String(value).trim() !== "") {
        return value;
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
}

function objectNumberByKey(source, keys) {
  const value = objectValueByKey(source, keys);
  if (value === "" || value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return parseMoneyText(value);
}

function normalizeText(value) {
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

function parseMoneyText(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function rawTextFromObject(source, maxDepth = 3) {
  const parts = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (value === undefined || value === null || depth > maxDepth) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) parts.push(text);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (/password|token|secret|cookie|csrf/i.test(key)) continue;
      visit(item, depth + 1);
    }
  };
  visit(source, 0);
  return parts.join(" ");
}

function isApprovedLike(value) {
  const status = normalizeText(value);
  if (!status) return false;
  return /(onaylandi|tamamlandi|completed|approved|success|succeeded)/.test(status)
    && !/(bekli|pending|iptal|cancel|fail|red|reject|error|basarisiz)/.test(status);
}

function transactionAmount(item) {
  return objectNumberByKey(item, [
    "approvedAmount",
    "approvedTotalAmount",
    "confirmedAmount",
    "confirmationAmount",
    "finalAmount",
    "processedAmount",
    "completedAmount",
    "paidAmount",
    "receivedAmount",
    "netAmount",
    "actualAmount",
    "acceptedAmount",
    "successAmount",
    "amount",
    "requestAmount",
    "requestedAmount",
    "totalAmount",
    "price",
    "value"
  ]);
}

function transactionRequestedAmount(item) {
  return objectNumberByKey(item, [
    "requestAmount",
    "requestedAmount",
    "originalAmount",
    "initialAmount",
    "amount"
  ]);
}

function transactionFinalAmountKey(item = {}) {
  const keys = [
    "approvedAmount",
    "approvedTotalAmount",
    "confirmedAmount",
    "confirmationAmount",
    "finalAmount",
    "processedAmount",
    "completedAmount",
    "paidAmount",
    "receivedAmount",
    "netAmount",
    "actualAmount",
    "acceptedAmount",
    "successAmount",
    "amount",
    "requestAmount",
    "requestedAmount",
    "totalAmount",
    "price",
    "value"
  ];
  for (const key of keys) {
    const value = objectValueByKey(item, [key]);
    if (value !== "" && value !== null && value !== undefined && objectNumberByKey(item, [key]) > 0) return key;
  }
  return "";
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

function maskIban(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  if (!clean) return "";
  return clean.length <= 8 ? clean : `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function compactTransaction(item = {}, fallbackType = "") {
  const bankAccount = item.bankAccount || item.account || item.assignedAccount || item.paymentAccount || {};
  const user = item.user || item.customer || item.member || {};
  const bank = pickFirst(
    item.bankName,
    item.bank,
    item.bankTitle,
    bankAccount.bankName,
    bankAccount.bank,
    bankAccount.bankTitle
  );
  const accountName = pickFirst(
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
  );
  const logText = String(pickFirst(
    item.description,
    item.note,
    item.notes,
    item.message,
    item.log,
    item.detail,
    item.details,
    item.lastLog,
    item.lastAction,
    item.auditLog,
    item.adminNote
  ) || "");
  const amount = transactionAmount(item);
  const requestedAmount = transactionRequestedAmount(item);
  const amountSource = transactionFinalAmountKey(item);
  const identifiers = [
    item._id,
    item.id,
    item.transactionId,
    item.processId,
    item.operationId,
    item.requestId,
    item.uuid
  ].map(value => String(value || "").trim()).filter(Boolean);
  return {
    id: identifiers[0] || "",
    identifiers: [...new Set(identifiers)],
    type: String(item.type || fallbackType || ""),
    amount,
    requestedAmount,
    editedAmount: Boolean(requestedAmount && amount && Math.round(requestedAmount) !== Math.round(amount)),
    amountSource,
    date: transactionDate(item),
    requestedAt: String(pickFirst(item.createdAt, item.requestDate, item.created_at, item.date) || ""),
    completedAt: String(pickFirst(item.completedAt, item.approvedAt, item.finishedAt, item.updatedAt) || ""),
    status: String(item.status || item.state || ""),
    bank: String(bank || ""),
    account: String(accountName || ""),
    accountLabel: [bank, accountName].filter(Boolean).join(" / "),
    iban: maskIban(pickFirst(item.iban, item.accountIban, bankAccount.iban, bankAccount.accountNumber)),
    user: String(pickFirst(user.fullName, user.name, item.userName, item.customerName, item.fullName, item.username) || ""),
    userId: String(pickFirst(
      typeof item.customerId === "string" ? item.customerId : "",
      typeof item.userId === "string" ? item.userId : "",
      user._id,
      user.id
    ) || ""),
    userUsername: String(pickFirst(user.username, item.customerUsername, item.userName, item.username) || ""),
    site: String(pickFirst(item.siteCode, item.siteName, item.site, item.merchantCode) || ""),
    logText,
    partialPayments: compactPartialPaymentsFromObject(item)
  };
}

function transactionTimeMs(item, keys = []) {
  for (const key of keys) {
    const value = item?.[key];
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function depositOutcome(value) {
  const statusText = normalizeText(value);
  if (isApprovedLike(statusText)) return "approved";
  if (/(iptal|cancel|fail|failed|red|reject|rejected|error|basarisiz|declined)/.test(statusText)) return "failed";
  if (/(bekli|pending|waiting|atandi|assigned|isleniyor|processing|queued)/.test(statusText)) return "pending";
  return "other";
}

function depositProfileTone(totalRequests, successRate, failedCount) {
  if (totalRequests < 3) return { level: "neutral", label: "AZ VERİ" };
  if (totalRequests >= 5 && successRate < 25 && failedCount >= 2) return { level: "risk", label: "SAHTE ŞÜPHESİ" };
  if (successRate >= 80) return { level: "trusted", label: "GÜVENİLİR" };
  if (successRate >= 60) return { level: "positive", label: "OLUMLU" };
  if (successRate >= 40) return { level: "suspicious", label: "ŞÜPHELİ" };
  return { level: "risk", label: "YÜKSEK RİSK" };
}

function buildDepositProfiles(historyGroup, nowMs = Date.now()) {
  const windowDays = 30;
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const profiles = {};
  const seen = new Set();
  for (const transaction of transactionArray(historyGroup)) {
    const userKey = normalizeText(transaction?.user);
    const occurredMs = transactionTimeMs(transaction, ["completedAt", "requestedAt", "updatedAt", "date"]);
    if (!userKey || !occurredMs || occurredMs < cutoffMs || occurredMs > nowMs + 60000) continue;
    const uniqueKey = String(transaction?.id || `${userKey}|${transaction?.requestedAt}|${transaction?.amount}|${transaction?.status}`);
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    const outcome = depositOutcome(transaction?.status);
    if (outcome === "other") continue;
    const profile = profiles[userKey] || {
      user: String(transaction?.user || ""), approvedCount: 0, failedCount: 0, pendingCount: 0,
      totalRequests: 0, approvedAmount: 0, lastRequestAt: "", lastApprovedAt: "", firstRequestAt: ""
    };
    profile.totalRequests += 1;
    if (outcome === "approved") {
      profile.approvedCount += 1;
      profile.approvedAmount += Number(transaction?.amount || 0);
      if (!profile.lastApprovedAt || occurredMs > Date.parse(profile.lastApprovedAt)) profile.lastApprovedAt = new Date(occurredMs).toISOString();
    } else if (outcome === "failed") profile.failedCount += 1;
    else profile.pendingCount += 1;
    if (!profile.lastRequestAt || occurredMs > Date.parse(profile.lastRequestAt)) profile.lastRequestAt = new Date(occurredMs).toISOString();
    if (!profile.firstRequestAt || occurredMs < Date.parse(profile.firstRequestAt)) profile.firstRequestAt = new Date(occurredMs).toISOString();
    profiles[userKey] = profile;
  }
  for (const profile of Object.values(profiles)) {
    profile.resolvedCount = profile.approvedCount + profile.failedCount;
    profile.successRate = profile.totalRequests ? Math.round((profile.approvedCount / profile.totalRequests) * 100) : 0;
    profile.resolvedSuccessRate = profile.resolvedCount ? Math.round((profile.approvedCount / profile.resolvedCount) * 100) : 0;
    profile.averageApprovedAmount = profile.approvedCount ? profile.approvedAmount / profile.approvedCount : 0;
    Object.assign(profile, depositProfileTone(profile.totalRequests, profile.successRate, profile.failedCount));
  }
  return { generatedAt: new Date(nowMs).toISOString(), windowDays, users: profiles };
}

function buildDepositRequestRisk(depositsGroup, activeGroup, nowMs = Date.now(), depositProfiles = null) {
  const windowMinutes = 60;
  const windowMs = windowMinutes * 60 * 1000;
  const cutoffMs = nowMs - windowMs;
  const approvedByUser = new Map();
  const activeByUser = new Map();
  const approvedIdentifiers = new Set();

  for (const transaction of transactionArray(depositsGroup)) {
    const userKey = normalizeText(transaction?.user);
    const completedMs = transactionTimeMs(transaction, ["completedAt", "updatedAt", "date"]);
    if (!userKey || !completedMs || completedMs < cutoffMs || completedMs > nowMs + 60000) continue;
    const list = approvedByUser.get(userKey) || [];
    list.push({
      id: String(transaction.id || ""),
      identifiers: Array.isArray(transaction.identifiers) ? transaction.identifiers : [transaction.id].filter(Boolean),
      user: String(transaction.user || ""),
      amount: Number(transaction.amount || 0),
      completedAt: new Date(completedMs).toISOString(),
      account: String(transaction.account || ""),
      bank: String(transaction.bank || "")
    });
    for (const identifier of Array.isArray(transaction.identifiers) ? transaction.identifiers : [transaction.id]) {
      if (identifier) approvedIdentifiers.add(String(identifier));
    }
    approvedByUser.set(userKey, list);
  }

  for (const transaction of transactionArray(activeGroup)) {
    const identifiers = Array.isArray(transaction?.identifiers) ? transaction.identifiers : [transaction?.id];
    if (identifiers.some(identifier => identifier && approvedIdentifiers.has(String(identifier)))) continue;
    const userKey = normalizeText(transaction?.user);
    if (!userKey) continue;
    const requestedMs = transactionTimeMs(transaction, ["requestedAt", "createdAt", "date"]);
    const list = activeByUser.get(userKey) || [];
    list.push({ transaction, requestedMs });
    activeByUser.set(userKey, list);
  }

  const users = {};
  const transactions = {};
  const userKeys = new Set([...approvedByUser.keys(), ...activeByUser.keys()]);

  for (const userKey of userKeys) {
    const approvals = (approvedByUser.get(userKey) || []).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
    const active = (activeByUser.get(userKey) || []).sort((a, b) => (a.requestedMs || nowMs) - (b.requestedMs || nowMs));
    const displayUser = String(active[0]?.transaction?.user || approvals[0]?.user || "");
    users[userKey] = {
      user: displayUser,
      approvedCount: approvals.length,
      activeCount: active.length,
      approvals
    };

    active.forEach((entry, index) => {
      const transaction = entry.transaction || {};
      const ordinal = approvals.length + index + 1;
      const alert = {
        id: String(transaction.id || ""),
        identifiers: Array.isArray(transaction.identifiers) ? transaction.identifiers : [transaction.id].filter(Boolean),
        user: String(transaction.user || displayUser),
        userKey,
        ordinal,
        level: ordinal > 1 ? "repeat" : "first",
        label: ordinal > 1 ? `1 SAATTE ${ordinal}. TALEP` : "İLK TALEP · TEKRAR YOK",
        requestedAt: entry.requestedMs ? new Date(entry.requestedMs).toISOString() : "",
        previousApprovals: approvals,
        profile: depositProfiles?.users?.[userKey] || null
      };
      for (const identifier of alert.identifiers) {
        if (identifier) transactions[String(identifier)] = alert;
      }
      if (alert.id) transactions[alert.id] = alert;
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowMinutes,
    users,
    transactions,
    approvedCount: [...approvedByUser.values()].reduce((sum, items) => sum + items.length, 0),
    activeCount: [...activeByUser.values()].reduce((sum, items) => sum + items.length, 0)
  };
}

function compactPartialPayment(raw = {}, parent = {}) {
  const bankAccount = raw.bankAccount
    || raw.account
    || raw.assignedAccount
    || raw.paymentAccount
    || raw.targetAccount
    || raw.accountSnapshot
    || raw.bankAccountSnapshot
    || {};
  const department = raw.department
    || raw.departmentInfo
    || raw.departmentSnapshot
    || (typeof raw.departmentId === "object" ? raw.departmentId : null)
    || parent.department
    || parent.departmentInfo
    || parent.departmentSnapshot
    || (typeof parent.departmentId === "object" ? parent.departmentId : null)
    || {};
  const bank = pickFirst(
    raw.bankName,
    raw.bank,
    raw.bankTitle,
    raw.accountSnapshot?.bankName,
    raw.accountSnapshot?.bank,
    bankAccount.bankName,
    bankAccount.bank,
    bankAccount.bankTitle,
    bankAccount.name
  );
  const account = pickFirst(
    raw.accountName,
    raw.accountHolderName,
    raw.holderName,
    raw.receiverName,
    raw.senderName,
    raw.ownerName,
    raw.owner,
    raw.fullName,
    raw.name,
    raw.setName,
    raw.accountSnapshot?.setName,
    raw.accountSnapshot?.accountName,
    raw.accountSnapshot?.displayName,
    bankAccount.accountName,
    bankAccount.accountHolderName,
    bankAccount.holderName,
    bankAccount.setName,
    bankAccount.fullName,
    bankAccount.name,
    parent.account,
    parent.accountName,
    parent.setName
  );
  const departmentName = pickFirst(
    raw.departmentName,
    typeof raw.department === "string" ? raw.department : "",
    department.departmentName,
    department.name,
    department.title,
    parent.departmentName
  );
  const amount = objectNumberByKey(raw, [
    "amount",
    "approvedAmount",
    "paidAmount",
    "paymentAmount",
    "transferAmount",
    "withdrawalAmount",
    "value"
  ]);
  const statusText = String(pickFirst(raw.status, raw.state, raw.paymentStatus, parent.status) || "");
  return {
    id: String(pickFirst(raw._id, raw.id, raw.paymentId, raw.partId, raw.processId) || ""),
    transactionId: String(parent.transactionId || parent.id || ""),
    status: statusText,
    amount,
    department: String(departmentName || ""),
    bank: String(bank || ""),
    account: String(account || ""),
    accountLabel: [bank, account].filter(Boolean).join(" / "),
    iban: maskIban(pickFirst(
      raw.iban,
      raw.accountIban,
      raw.displayIban,
      raw.accountSnapshot?.iban,
      raw.accountSnapshot?.displayIban,
      bankAccount.iban,
      bankAccount.displayIban,
      bankAccount.accountNumber
    )),
    assignedAt: String(pickFirst(raw.assignedAt, raw.lockedAt, raw.createdAt, parent.date) || ""),
    completedAt: String(pickFirst(raw.completedAt, raw.approvedAt, raw.finishedAt, raw.updatedAt, parent.completedAt) || ""),
    source: "api-detail"
  };
}

function compactPartialPaymentsFromObject(item = {}) {
  const parent = {
    id: String(item._id || item.id || item.transactionId || item.processId || item.operationId || ""),
    status: String(item.status || item.state || ""),
    date: transactionDate(item),
    completedAt: String(pickFirst(item.completedAt, item.approvedAt, item.finishedAt, item.updatedAt) || "")
  };
  const keyHints = /(partial|parc|parça|split|part|payment|odeme|ödeme)/i;
  const found = [];
  const seen = new Set();

  const pushPayment = (raw, context = parent) => {
    const payment = compactPartialPayment(raw, context);
    if (payment.amount && (payment.account || payment.bank || payment.iban || payment.department)) {
      found.push(payment);
    }
  };

  const contextFromPartial = (partial = {}, context = parent) => ({
    ...context,
    partialId: String(pickFirst(partial._id, partial.id, partial.paymentId) || context.partialId || ""),
    status: String(pickFirst(partial.status, partial.state, context.status) || ""),
    department: partial.department || partial.departmentInfo || partial.departmentSnapshot || partial.departmentId || context.department,
    departmentName: pickFirst(
      partial.departmentName,
      partial.departmentSnapshot?.name,
      partial.departmentSnapshot?.departmentName,
      partial.departmentId?.name,
      partial.departmentId?.departmentName,
      context.departmentName
    ),
    date: pickFirst(partial.assignedAt, partial.createdAt, context.date),
    completedAt: pickFirst(partial.completedAt, partial.approvedAt, partial.updatedAt, context.completedAt)
  });

  const visit = (value, key = "", depth = 0, context = parent) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      const hinted = keyHints.test(key);
      for (const item of value) {
        if (item && typeof item === "object") {
          const itemContext = contextFromPartial(item, context);
          if (Array.isArray(item.payments) && item.payments.length) {
            for (const payment of item.payments) pushPayment(payment, itemContext);
          }
          const text = rawTextFromObject(item, 2);
          const hasPaymentShape = objectNumberByKey(item, ["amount", "approvedAmount", "paidAmount", "paymentAmount", "transferAmount", "withdrawalAmount"]) > 0
            && /(depart|bank|iban|hesap|account|simsek|şimşek)/i.test(text);
          if (hinted || hasPaymentShape) pushPayment(item, itemContext);
          visit(item, key, depth + 1, itemContext);
        }
      }
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (/password|token|secret|cookie|csrf/i.test(childKey)) continue;
      if (/^payments$/i.test(childKey) && Array.isArray(childValue)) {
        const partialContext = contextFromPartial(value, context);
        for (const payment of childValue) pushPayment(payment, partialContext);
      }
      visit(childValue, childKey, depth + 1, context);
    }
  };
  visit(item);
  const unique = new Map();
  for (const payment of found) {
    if (!payment.amount || (!payment.account && !payment.bank && !payment.iban)) continue;
    const key = [payment.transactionId, payment.department, payment.bank, payment.account, payment.iban, payment.amount].join("|");
    unique.set(key, payment);
  }
  return [...unique.values()];
}

function compactTransactions(payload, fallbackType = "") {
  const items = transactionArray(payload);
  const transactions = items.map(item => compactTransaction(item, fallbackType));
  return {
    data: { transactions },
    count: transactions.length,
    total: transactions.reduce((sum, item) => sum + item.amount, 0),
    pagination: payload?.data?.pagination || payload?.pagination || null
  };
}

function mergeTransactionPayloads(payloads = [], fallbackType = "") {
  const transactions = [];
  const seen = new Set();
  const pages = [];
  for (const payload of payloads.filter(Boolean)) {
    const pagination = payload?.data?.pagination || payload?.pagination || null;
    if (pagination) pages.push(pagination);
    for (const raw of transactionArray(payload)) {
      const item = compactTransaction(raw, fallbackType);
      const key = item.id || [
        item.type,
        item.date,
        item.completedAt,
        item.bank,
        item.account,
        item.iban,
        item.amount,
        item.user
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      transactions.push(item);
    }
  }
  return {
    data: { transactions },
    count: transactions.length,
    total: transactions.reduce((sum, item) => sum + item.amount, 0),
    pagination: pages[0] || null,
    pagesFetched: pages.length || (payloads.length ? 1 : 0)
  };
}

function compactBankAccount(item = {}) {
  const bankObject = item.bank || item.bankId || item.bankInfo || item.bankAccount || item.account || item.paymentAccount || {};
  const setObject = item.set || item.setId || item.setInfo || item.ownerSet || {};
  const departmentObject = item.department || item.departmentInfo || {};
  const bank = pickFirst(
    item.bankName,
    item.bankTitle,
    typeof item.bank === "string" ? item.bank : "",
    typeof item.bankId === "string" ? "" : item.bankId?.name,
    typeof item.bankId === "string" ? "" : item.bankId?.title,
    bankObject.bankName,
    bankObject.bankTitle,
    bankObject.name,
    bankObject.title
  );
  const accountName = pickFirst(
    item.accountName,
    item.accountHolderName,
    item.holderName,
    item.ownerName,
    item.owner,
    item.setName,
    item.name,
    item.fullName,
    item.receiverName,
    item.senderName,
    typeof item.setId === "string" ? "" : item.setId?.name,
    typeof item.setId === "string" ? "" : item.setId?.setName,
    setObject.name,
    setObject.setName,
    setObject.ownerName,
    bankObject.accountName,
    bankObject.accountHolderName,
    bankObject.holderName,
    bankObject.name,
    bankObject.fullName
  );
  const department = pickFirst(
    item.departmentName,
    item.department,
    departmentObject.departmentName,
    departmentObject.name,
    departmentObject.title,
    typeof item.setId === "string" ? "" : item.setId?.departmentId?.name,
    typeof item.setId === "string" ? "" : item.setId?.departmentId?.departmentName,
    setObject.departmentId?.name,
    setObject.departmentId?.departmentName
  );
  const depositCount = objectNumberByKey(item, [
    "depositCount",
    "todayDepositCount",
    "dailyDepositCount",
    "completedDepositCount",
    "transactionCount",
    "todayTransactionCount",
    "dailyTransactionCount",
    "currentDailyTransactionCount",
    "usedTransactionCount",
    "totalTransactions",
    "totalTransactionCount",
    "completedTransactionCount"
  ]);
  const depositLimit = objectNumberByKey(item, [
    "depositLimitCount",
    "transactionLimit",
    "dailyTransactionLimit",
    "maxTransactionCount",
    "limitCount"
  ]);
  const depositVolume = objectNumberByKey(item, [
    "depositVolume",
    "todayDepositVolume",
    "dailyDepositVolume",
    "depositAmount",
    "todayDepositAmount",
    "dailyDepositAmount",
    "totalDepositAmount",
    "volume",
    "totalVolume",
    "todayVolume",
    "dailyVolume",
    "currentDailyVolume",
    "transactionVolume",
    "completedAmount"
  ]);
  return {
    id: String(pickFirst(item._id, item.id, item.accountId, item.bankAccountId, item.paymentAccountId) || ""),
    department: String(department || ""),
    bank: String(bank || ""),
    account: String(accountName || ""),
    iban: maskIban(objectValueByKey(item, ["iban", "displayIban", "accountIban", "ibanNumber", "accountNumber"])),
    depositCount,
    depositLimit,
    depositVolume,
    min: objectNumberByKey(item, ["min", "minAmount", "minDepositAmount", "minimumAmount"]),
    max: objectNumberByKey(item, ["max", "maxAmount", "maxDepositAmount", "maximumAmount"]),
    status: String(pickFirst(item.status, item.state, item.accountStatus) || "")
  };
}

function compactBankAccounts(payload, source = "") {
  const accounts = accountArray(payload)
    .map(item => compactBankAccount(item))
    .filter(item => item.bank || item.account || item.iban);
  return {
    source,
    count: accounts.length,
    accounts,
    pagination: payload?.data?.pagination || payload?.pagination || null
  };
}

function uniqueAccounts(accounts) {
  const accountsByKey = new Map();
  for (const account of accounts) {
    const key = [
      account.iban,
      account.bank.toLocaleLowerCase("tr-TR"),
      account.account.toLocaleLowerCase("tr-TR")
    ].join("|");
    if (!accountsByKey.has(key) || account.depositCount || account.depositVolume) {
      accountsByKey.set(key, account);
    }
  }
  return [...accountsByKey.values()];
}

function findBrowserExecutable() {
  const configured = process.env.MOON_BROWSER_EXECUTABLE;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  return candidates.find(filePath => fs.existsSync(filePath)) || "";
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  const bytes = [];

  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
    while (bits.length >= 8) {
      bytes.push(parseInt(bits.slice(0, 8), 2));
      bits = bits.slice(8);
    }
  }

  return Buffer.from(bytes);
}

function totpOptions() {
  const algorithm = String(process.env.MOON_TOTP_ALGORITHM || "sha1").toLowerCase();
  return {
    algorithm: ["sha1", "sha256", "sha512"].includes(algorithm) ? algorithm : "sha1",
    stepSeconds: numberEnv("MOON_TOTP_STEP_SECONDS", 30),
    digits: numberEnv("MOON_TOTP_DIGITS", 6)
  };
}

function generateTotp(secret, now = Date.now(), stepSeconds = 30, digits = 6, algorithm = "sha1") {
  const key = base32Decode(secret);
  if (!key.length) throw new Error("MOON_TOTP_SECRET boş veya geçersiz.");
  const counter = BigInt(Math.floor(now / 1000 / stepSeconds));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac(algorithm, key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

async function clickLikelySubmit(page) {
  const candidates = [
    page.getByRole("button", { name: /giriş|giris|login|devam|doğrula|dogrula|verify|onay/i }).first(),
    page.locator("button").filter({ hasText: /giriş|giris|login|devam|doğrula|dogrula|verify|onay/i }).first(),
    page.locator('button[type="submit"]').first()
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 5000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  await page.keyboard.press("Enter").catch(() => {});
  return false;
}

async function visible(locator, timeout = 1000) {
  try {
    return await locator.isVisible({ timeout });
  } catch {
    return false;
  }
}

async function waitVisible(locator, timeout = 10000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

class MoonAutomation {
  constructor(options = {}) {
    const previousLive = readPreviousMoonLive();
    this.onPayload = options.onPayload || null;
    this.context = null;
    this.page = null;
    this.timer = null;
    this.busy = false;
    this.loginAttempts = 0;
    this.intervalMs = Math.max(1000, numberEnv("MOON_AUTOMATION_INTERVAL_MS", 1000));
    this.fetchTimeoutMs = numberEnv("MOON_FETCH_TIMEOUT_MS", 10000);
    this.maxConsecutiveErrors = Math.max(1, numberEnv("MOON_MAX_CONSECUTIVE_ERRORS", 3));
    this.staleRestartMs = Math.max(this.intervalMs * 3, numberEnv("MOON_STALE_RESTART_MS", 15000));
    this.minRestartGapMs = Math.max(1000, numberEnv("MOON_MIN_RESTART_GAP_MS", 10000));
    this.browserFallbackEnabled = boolEnv("MOON_BROWSER_FETCH_FALLBACK", true);
    this.pageHeartbeatMs = Math.max(1000, numberEnv("MOON_PAGE_HEARTBEAT_MS", 5000));
    this.lastHeartbeatMs = 0;
    this.lastSuccessfulCycleMs = 0;
    this.userDataDir = process.env.MOON_AUTH_DIR || path.join(root, "moon-auth-storage");
    this.totpSecretPath = path.join(this.userDataDir, "moon-totp-secret.txt");
    this.deviceName = process.env.MOON_DEVICE_NAME || `${os.hostname()}-moon-bot`;
    this.accountStatsCandidates = [];
    this.accountStatsLastDiscovery = 0;
    this.accountStatsDisabledUntil = 0;
    this.accountStatsProbeIndex = 0;
    this.accountStatsPagePath = "";
    this.lastAccountStatsBundle = previousLive?.accountStats || null;
    this.lastAccountStatsAt = this.lastAccountStatsBundle ? Date.now() : 0;
    this.lastTransactionsBundle = previousLive?.transactions ? stableTransactionBundle(previousLive.transactions) : null;
    this.lastFullDepositsBundle = previousLive?.transactions?.deposits || null;
    this.lastFullDepositsAt = this.lastFullDepositsBundle ? (Date.parse(previousLive?.capturedAt || "") || Date.now()) : 0;
    this.depositBackgroundPromise = null;
    this.lastDepositRequestRisk = previousLive?.depositRequestRisk || null;
    this.lastDepositRequestRiskAt = this.lastDepositRequestRisk ? (Date.parse(previousLive?.capturedAt || "") || 0) : 0;
    this.depositRequestRiskPromise = null;
    this.depositRequestRiskRefreshMs = Math.max(1000, numberEnv("MOON_DEPOSIT_RISK_REFRESH_MS", 2000));
    this.lastDepositProfiles = previousLive?.depositProfiles || null;
    this.lastDepositProfilesAt = this.lastDepositProfiles ? (Date.parse(this.lastDepositProfiles.generatedAt || "") || 0) : 0;
    this.depositProfilesPromise = null;
    this.depositProfilesRefreshMs = Math.max(30000, numberEnv("MOON_DEPOSIT_PROFILE_REFRESH_MS", 120000));
    this.depositProfilesMaxPages = Math.max(1, Math.min(20, numberEnv("MOON_DEPOSIT_PROFILE_MAX_PAGES", 10)));
    this.lastWithdrawalPartialsBundle = previousLive?.transactions?.withdrawalPartials || null;
    this.lastWithdrawalPartialsAt = this.lastWithdrawalPartialsBundle ? Date.now() : 0;
    this.withdrawalPartialsDisabledUntil = 0;
    this.enrichmentRefreshPromise = null;
    this.lastEnrichmentRefreshAt = previousLive?.capturedAt ? (Date.parse(previousLive.capturedAt) || 0) : 0;
    this.enrichmentRefreshMs = Math.max(5000, numberEnv("MOON_DETAIL_REFRESH_MS", 30000));
    this.initialEnrichmentWaitMs = Math.max(0, numberEnv("MOON_INITIAL_DETAIL_WAIT_MS", 1200));
    this.depositPaginationEnabled = boolEnv("MOON_DEPOSIT_PAGINATION_ENABLED", false);
    this.depositBackgroundEnabled = !boolEnv("MOON_DEPOSIT_BACKGROUND_DISABLED", false);
    this.depositBackgroundRefreshMs = Math.max(15000, numberEnv("MOON_DEPOSIT_BACKGROUND_REFRESH_MS", 45000));
    this.depositBackgroundMaxPages = Math.max(1, Math.min(50, numberEnv("MOON_DEPOSIT_BACKGROUND_MAX_PAGES", 20)));
    status.deviceName = this.deviceName;
    status.depositBackgroundEnabled = this.depositBackgroundEnabled;
    status.depositBackgroundRefreshMs = this.depositBackgroundRefreshMs;
    status.depositBackgroundMaxPages = this.depositBackgroundMaxPages;
  }

  async start() {
    status.enabled = true;
    status.running = true;
    status.health = "starting";
    this.schedule(0);
    return this;
  }

  async stop() {
    status.running = false;
    status.health = "stopped";
    clearTimeout(this.timer);
    this.timer = null;
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  schedule(ms = this.intervalMs) {
    if (!status.running) return;
    clearTimeout(this.timer);
    status.nextRunAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => {
      this.runLoop().catch(error => {
        status.lastError = error.message;
        this.schedule(this.intervalMs);
      });
    }, ms);
  }

  async runLoop() {
    if (this.busy) {
      this.schedule(250);
      return;
    }
    this.busy = true;
    const startedAt = Date.now();
    try {
      await this.runOnce();
      this.lastSuccessfulCycleMs = Date.now();
      status.lastSuccessAt = new Date().toISOString();
      status.consecutiveErrors = 0;
      status.lastError = "";
      status.health = "ok";
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = error.message;
      status.health = "error";
      if (this.shouldResetAfterError(error)) {
        await this.resetSession(this.resetReasonForError(error));
      }
    } finally {
      status.lastCycleMs = Date.now() - startedAt;
      this.busy = false;
      this.schedule(this.intervalMs);
    }
  }

  shouldResetAfterError(error) {
    const message = String(error?.message || "");
    if (/401|403|yetki|login|oturum|auth|forbidden|unauthorized/i.test(message)) return true;
    if (status.consecutiveErrors >= this.maxConsecutiveErrors) return true;
    const staleForMs = this.lastSuccessfulCycleMs ? Date.now() - this.lastSuccessfulCycleMs : 0;
    return staleForMs > this.staleRestartMs;
  }

  resetReasonForError(error) {
    const message = String(error?.message || "");
    if (/401|403|yetki|login|oturum|auth|forbidden|unauthorized/i.test(message)) return "auth-error";
    if (status.consecutiveErrors >= this.maxConsecutiveErrors) return "consecutive-errors";
    return "stale-live-loop";
  }

  async ensureContext() {
    if (this.context && this.page) return;
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const executablePath = findBrowserExecutable();
    const launchOptions = {
      headless: boolEnv("MOON_HEADLESS", true),
      args: ["--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox"],
      timeout: numberEnv("MOON_BROWSER_LAUNCH_TIMEOUT_MS", 45000),
      viewport: { width: 1440, height: 900 }
    };
    if (executablePath) {
      launchOptions.executablePath = executablePath;
      status.browser = executablePath;
    } else {
      status.browser = "playwright-managed";
    }

    this.context = await chromium.launchPersistentContext(this.userDataDir, launchOptions);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(numberEnv("MOON_PAGE_TIMEOUT_MS", 30000));
  }

  async resetSession(reason = "manual") {
    const lastRestartMs = Date.parse(status.lastRestartAt || "") || 0;
    if (lastRestartMs && Date.now() - lastRestartMs < this.minRestartGapMs) return;
    status.restartCount += 1;
    status.lastRestartAt = new Date().toISOString();
    status.lastRestartReason = reason;
    status.health = "restarting";
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  async cookieHeader() {
    await this.ensureContext();
    const cookies = await this.context.cookies(["https://moon.aypay.co", "https://moon-api.aypay.co"]);
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async fetchMoonPayload() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(moonApiUrl, {
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Origin": "https://moon.aypay.co",
          "Referer": "https://moon.aypay.co/",
          "User-Agent": "Mozilla/5.0",
          "Cookie": await this.cookieHeader()
        }
      });
      if (!response.ok) throw new Error(`Moon API ${response.status}`);
      const payload = await response.json();
      if (!payload?.success && !payload?.data?.departments) throw new Error("Moon API beklenen departman verisini döndürmedi.");
      status.lastFetchAt = new Date().toISOString();
      status.lastFetchTransport = "node-cookie";
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchMoonPayloadViaBrowser() {
    if (!this.browserFallbackEnabled) {
      throw new Error("Moon browser fetch fallback kapalı.");
    }
    const payload = await this.fetchMoonJsonInBrowser(moonApiUrl);
    if (!payload?.success && !payload?.data?.departments) {
      throw new Error("Moon browser API beklenen departman verisini döndürmedi.");
    }
    status.lastFetchAt = new Date().toISOString();
    status.lastFetchTransport = "browser-context";
    return payload;
  }

  async fetchLivePayload() {
    try {
      return await this.fetchMoonPayload();
    } catch (nodeError) {
      try {
        return await this.fetchMoonPayloadViaBrowser();
      } catch (browserError) {
        throw new Error(`${nodeError.message}; browser fallback: ${browserError.message}`);
      }
    }
  }

  async heartbeatMoonPage(options = {}) {
    const force = options.force === true;
    if (!this.page || (!force && Date.now() - this.lastHeartbeatMs < this.pageHeartbeatMs)) return;
    this.lastHeartbeatMs = Date.now();
    try {
      const currentUrl = this.page.url();
      if (!currentUrl || !currentUrl.startsWith("https://moon.aypay.co")) {
        await this.page.goto(moonHomeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      }
      await Promise.race([
        this.fetchMoonPayloadViaBrowser(),
        delay(Math.min(2500, this.fetchTimeoutMs))
      ]);
      status.lastHeartbeatAt = new Date().toISOString();
    } catch {
      // The fast API loop is authoritative; heartbeat is only a session warmer.
    }
  }

  transactionsUrl(type, status = "", page = 1, limit = process.env.MOON_TRANSACTIONS_LIMIT || "500", params = {}) {
    const url = new URL(moonTransactionsUrl);
    url.searchParams.set("type", type);
    if (status) url.searchParams.set("status", status);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(key, String(value));
    });
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  async fetchMoonJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Origin": "https://moon.aypay.co",
          "Referer": "https://moon.aypay.co/",
          "User-Agent": "Mozilla/5.0",
          "Cookie": await this.cookieHeader()
        }
      });
      if (!response.ok) throw new Error(`Moon API ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchMoonJsonInBrowser(pathnameOrUrl) {
    await this.ensureContext();
    const currentUrl = this.page.url();
    if (!currentUrl || !currentUrl.startsWith("https://moon.aypay.co")) {
      await this.page.goto(moonHomeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    }
    const url = new URL(pathnameOrUrl, moonApiBaseUrl).toString();
    return this.page.evaluate(async targetUrl => {
      const tokenKeys = [
        "token",
        "accessToken",
        "authToken",
        "jwt",
        "moon_token",
        "aypay_token"
      ];
      const token = tokenKeys
        .map(key => localStorage.getItem(key) || sessionStorage.getItem(key))
        .find(Boolean);
      const headers = { "Accept": "application/json, text/plain, */*" };
      if (token) {
        headers.Authorization = String(token).startsWith("Bearer ") ? token : `Bearer ${token}`;
      }
      const response = await fetch(targetUrl, {
        credentials: "include",
        headers
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Moon browser API ${response.status}: ${text.slice(0, 120)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }, url);
  }

  async fetchMoonJsonReliable(url) {
    try {
      return await this.fetchMoonJson(url);
    } catch (nodeError) {
      try {
        return await this.fetchMoonJsonInBrowser(url);
      } catch (browserError) {
        throw new Error(`${nodeError.message}; browser fallback: ${browserError.message}`);
      }
    }
  }

  async fetchTransactionPages(type, status = "", options = {}) {
    const limit = String(options.limit || process.env.MOON_TRANSACTIONS_LIMIT || "500");
    const optionMaxPages = Number(options.maxPages || 0);
    const requestedMaxPages = optionMaxPages > 0
      ? Math.max(1, Math.min(50, optionMaxPages))
      : Math.max(1, Math.min(50, numberEnv("MOON_TRANSACTIONS_MAX_PAGES", 20)));
    const maxPages = options.paginate === false ? 1 : requestedMaxPages;
    const payloads = [];
    let expectedPages = 1;

    for (let page = 1; page <= Math.min(expectedPages, maxPages); page += 1) {
      const payload = await this.fetchMoonJsonReliable(this.transactionsUrl(type, status, page, limit, options.params));
      payloads.push(payload);
      const pagination = payload?.data?.pagination || payload?.pagination || {};
      const pages = Number(pagination.pages || pagination.totalPages || 0);
      const total = Number(pagination.total || 0);
      const pageLimit = Number(pagination.limit || limit || 0);
      const inferredPages = pageLimit > 0 && total > 0 ? Math.ceil(total / pageLimit) : 0;
      expectedPages = Math.max(1, pages || inferredPages || expectedPages);
      if (!transactionArray(payload).length && page > 1) break;
    }

    return mergeTransactionPayloads(payloads, type);
  }

  async fetchApprovedDeposits(options = {}) {
    const candidates = String(process.env.MOON_DEPOSIT_APPROVED_STATUSES || "approved,completed,onaylandi,onaylandı,success,succeeded")
      .split(/[|;]/)
      .map(group => group.trim())
      .filter(Boolean);
    const groups = candidates.length ? candidates : ["approved,completed,onaylandi,onaylandı,success,succeeded"];
    const bundles = [];

    for (const statusText of groups) {
      try {
        const bundle = await this.fetchTransactionPages("deposit", statusText, {
          paginate: options.paginate ?? this.depositPaginationEnabled,
          maxPages: options.maxPages
        });
        if (bundle.count) {
          bundle.statusQuery = statusText;
          bundles.push(bundle);
          break;
        }
      } catch {
        // Try the next known status shape.
      }
    }

    if (!bundles.length) {
      const allDeposits = await this.fetchTransactionPages("deposit", "", {
        paginate: options.paginate ?? this.depositPaginationEnabled,
        maxPages: options.maxPages
      });
      const approved = allDeposits.data.transactions.filter(item => isApprovedLike(item.status));
      return {
        ...allDeposits,
        data: { transactions: approved },
        count: approved.length,
        total: approved.reduce((sum, item) => sum + item.amount, 0),
        statusQuery: "client-filter-approved"
      };
    }

    return bundles[0];
  }

  async fetchTransactionBundle() {
    const fetchOne = async (type, status = "") => {
      try {
        return await this.fetchTransactionPages(type, status);
      } catch {
        return null;
      }
    };
    const [deposits, withdrawals, activeDeposits, activeWithdrawals] = await Promise.all([
      this.fetchApprovedDeposits().catch(() => fetchOne("deposit")),
      fetchOne("withdrawal"),
      fetchOne("deposit", "pending,assigned"),
      fetchOne("withdrawal", "pending,assigned")
    ]);
    return {
      deposits: this.lastFullDepositsBundle || deposits || compactTransactions(null, "deposit"),
      withdrawals: withdrawals || compactTransactions(null, "withdrawal"),
      activeDeposits: activeDeposits || compactTransactions(null, "deposit"),
      activeWithdrawals: activeWithdrawals || compactTransactions(null, "withdrawal")
    };
  }

  async fetchTransactionDetail(id, type = "withdrawal") {
    if (!id) return null;
    const candidates = [
      `/v1/transactions/${encodeURIComponent(id)}`,
      `/v1/transactions/${encodeURIComponent(id)}/partial-payments`,
      `/v1/transactions/${encodeURIComponent(id)}/logs`,
      `/v1/withdrawals/${encodeURIComponent(id)}`,
      `/v1/${type}s/${encodeURIComponent(id)}`
    ];
    for (const pathname of candidates) {
      try {
        return await this.fetchMoonJson(new URL(pathname, moonApiBaseUrl).toString());
      } catch {
        // Try the next detail endpoint.
      }
    }
    return null;
  }

  async fetchWithdrawalPartialBundle(transactions = {}) {
    const cacheMs = Math.max(1000, numberEnv("MOON_WITHDRAWAL_PARTIALS_CACHE_MS", 5000));
    if (this.lastWithdrawalPartialsBundle && Date.now() - this.lastWithdrawalPartialsAt < cacheMs) {
      return this.lastWithdrawalPartialsBundle;
    }
    if (Date.now() < this.withdrawalPartialsDisabledUntil) {
      return this.lastWithdrawalPartialsBundle || { source: "cache-empty", count: 0, payments: [] };
    }

    const payments = [];
    const list = transactions?.withdrawals?.data?.transactions || [];
    for (const item of list) {
      for (const payment of item.partialPayments || []) {
        payments.push({ ...payment, source: payment.source || "transaction-list" });
      }
    }

    const detailLimit = Math.max(0, numberEnv("MOON_WITHDRAWAL_DETAIL_API_LIMIT", 40));
    if (!payments.length && detailLimit) {
      for (const item of list.slice(0, detailLimit)) {
        if (!item.id || !isApprovedLike(item.status)) continue;
        const details = [];
        const detail = await this.fetchMoonJsonInBrowser(`/v1/transactions/${encodeURIComponent(item.id)}`)
          .catch(() => this.fetchTransactionDetail(item.id, "withdrawal"));
        if (detail) details.push(detail);
        const partialEndpoint = await this.fetchMoonJsonInBrowser(`/v1/transactions/${encodeURIComponent(item.id)}/partial-payments`)
          .catch(() => this.fetchMoonJson(new URL(`/v1/transactions/${encodeURIComponent(item.id)}/partial-payments`, moonApiBaseUrl).toString()))
          .catch(() => null);
        if (partialEndpoint) details.push(partialEndpoint);
        for (const detailPayload of details) {
          for (const payment of compactPartialPaymentsFromObject(detailPayload || {})) {
            payments.push({ ...payment, transactionId: payment.transactionId || item.id, source: "api-detail" });
          }
        }
      }
    }

    const pageBundle = boolEnv("MOON_WITHDRAWAL_PAGE_SCRAPE_ENABLED", false)
      ? await this.scrapeWithdrawalPartialsFromPage().catch(() => null)
      : null;
    if (pageBundle?.payments?.length) payments.push(...pageBundle.payments);

    const unique = new Map();
    for (const payment of payments) {
      if (!payment || !payment.amount || (!payment.account && !payment.bank && !payment.iban)) continue;
      const key = [
        payment.transactionId,
        normalizeText(payment.department),
        normalizeText(payment.bank),
        normalizeText(payment.account),
        String(payment.iban || "").replace(/\s+/g, ""),
        Math.round(Number(payment.amount) || 0)
      ].join("|");
      unique.set(key, payment);
    }
    const result = {
      source: pageBundle?.payments?.length ? "withdrawals-page" : "transaction-detail",
      count: unique.size,
      capturedAt: new Date().toISOString(),
      payments: [...unique.values()]
    };
    this.lastWithdrawalPartialsBundle = result;
    this.lastWithdrawalPartialsAt = Date.now();
    if (!result.count) this.withdrawalPartialsDisabledUntil = Date.now() + Math.max(5000, cacheMs);
    return result;
  }

  async scrapeWithdrawalPartialsFromPage() {
    await this.ensureContext();
    const pageLimit = Math.max(1, numberEnv("MOON_WITHDRAWAL_PAGE_DETAIL_LIMIT", 30));
    await this.page.goto("https://moon.aypay.co/withdrawals", { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await this.page.waitForTimeout(500).catch(() => {});

    const approvedTab = this.page.locator("button, [role='tab']").filter({ hasText: /onaylandi|onaylandı|tamamlandi|tamamlandı/i }).first();
    if (await visible(approvedTab, 900)) {
      await approvedTab.click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(500).catch(() => {});
    }

    const payments = [];
    const logButtons = this.page.locator("button").filter({ hasText: /^Log$/i });
    const count = Math.min(await logButtons.count().catch(() => 0), pageLimit);

    for (let index = 0; index < count; index += 1) {
      const button = logButtons.nth(index);
      try {
        if (!await button.isVisible({ timeout: 800 })) continue;
        const rowText = await button.locator("xpath=ancestor::*[self::tr or @role='row' or contains(@class,'row')][1]").innerText({ timeout: 800 }).catch(() => "");
        if (rowText && !/(onaylandi|onaylandı|tamamlandi|tamamlandı|completed|approved)/i.test(rowText)) continue;
        await button.scrollIntoViewIfNeeded().catch(() => {});
        await button.click({ timeout: 5000 });
        await this.page.waitForTimeout(350).catch(() => {});

        const partialTab = this.page.locator("button, [role='tab']").filter({ hasText: /parçalı ödemeler|parcali odemeler|parcali ödemeler|partial/i }).first();
        if (await visible(partialTab, 1200)) {
          await partialTab.click({ timeout: 3000 }).catch(() => {});
          await this.page.waitForTimeout(350).catch(() => {});
        }

        const parsed = await this.page.evaluate(() => {
          const visible = element => {
            if (!element) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const normalize = value => String(value || "")
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
          const parseAmount = value => {
            const clean = String(value || "")
              .replace(/[^\d,.\-]/g, "")
              .replace(/\.(?=\d{3}(\D|$))/g, "")
              .replace(",", ".");
            const number = Number(clean);
            return Number.isFinite(number) ? number : 0;
          };
          const bankNames = [
            "Akbank", "DenizBank", "Enpara", "Garanti BBVA", "Garanti", "Hadi", "Halkbank", "ING",
            "Kuveyt Türk", "QNB Finansbank", "QNB Finans", "TEB", "TOM", "VakıfBank", "Vakıf",
            "Yapı Kredi", "YapıKredi", "Ziraat Bankası", "Ziraat"
          ];
          const canonicalBank = bank => normalize(bank)
            .replace(/\bbankasi\b/g, "")
            .replace(/\bbank\b/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/^qnb finans$/, "qnb finansbank")
            .replace(/^yapikredi$/, "yapi kredi")
            .replace(/^vakif$/, "vakifbank");
          const bankFromText = text => {
            const normalized = normalize(text);
            return bankNames.find(bank => {
              const canonical = canonicalBank(bank);
              return canonical && normalized.includes(canonical);
            }) || "";
          };
          const badOwnerLine = line => {
            const n = normalize(line);
            return !n
              || /\b(departman|atayan|atanma|isleyen|tamamlanma|durum|onaylandi|bekliyor|isleniyor|simsek|aragonr|ece bozok|log|parcali|callback|min|maks|max|hacim|tutar)\b/.test(n)
              || /^#?\d+$/.test(n)
              || /^tr\d{2}/.test(n)
              || /\d{2}\.\d{2}\.\d{4}/.test(line)
              || /₺|tl/i.test(line)
              || bankNames.some(bank => canonicalBank(bank) === canonicalBank(line));
          };
          const roots = [...document.querySelectorAll("[role='dialog'], aside, section, main, body")]
            .filter(element => visible(element))
            .filter(element => /parçalı|parcali|durum geçmişi|durum gecmisi/i.test(element.innerText || ""))
            .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
          const root = roots[0] || document.body;
          const candidates = [...root.querySelectorAll("article, li, [class*='card'], [class*='item'], div")]
            .filter(element => visible(element))
            .map(element => element.innerText || "")
            .filter(text => text.length > 30 && text.length < 1200)
            .filter(text => /şimşek|simsek/i.test(text) && /₺|tl|\d[\d.]*,\d{2}/i.test(text));

          const unique = new Map();
          for (const text of candidates) {
            const currencyMatches = [...text.matchAll(/₺\s*([\d.]+(?:,\d{1,2})?|\d+)/g)].map(match => parseAmount(match[1])).filter(Boolean);
            const fallbackMatches = currencyMatches.length ? [] : [...text.matchAll(/\b(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{4,}(?:,\d{1,2})?)\b/g)]
              .map(match => parseAmount(match[1]))
              .filter(Boolean);
            const amountMatches = currencyMatches.length ? currencyMatches : fallbackMatches;
            const amount = amountMatches[amountMatches.length - 1] || 0;
            if (!amount) continue;
            const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
            const iban = (text.match(/TR[\d\s]{18,32}/i)?.[0] || "").replace(/\s+/g, "");
            const bank = bankFromText(text);
            const department = lines.find(line => /şimşek|simsek/i.test(line)) || "Şimşek";
            const completedAt = lines.find(line => /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(line)) || "";
            const owner = lines
              .filter(line => !badOwnerLine(line))
              .find(line => /[A-Za-zÇĞİÖŞÜçğıöşü]{2}/.test(line) && /\s/.test(line))
              || lines.find(line => !badOwnerLine(line) && /[A-Za-zÇĞİÖŞÜçğıöşü]{3}/.test(line))
              || "";
            if (!owner && !iban) continue;
            const key = [normalize(department), canonicalBank(bank), normalize(owner), iban, amount].join("|");
            unique.set(key, {
              amount,
              department,
              bank,
              account: owner,
              accountLabel: [bank, owner].filter(Boolean).join(" / "),
              iban: iban ? `${iban.slice(0, 4)}...${iban.slice(-4)}` : "",
              status: "Onaylandı",
              completedAt,
              source: "withdrawals-page"
            });
          }
          return [...unique.values()];
        });
        payments.push(...parsed);
        await this.page.keyboard.press("Escape").catch(() => {});
        const closeButton = this.page.locator("button").filter({ hasText: /^×$|kapat|close/i }).first();
        if (await visible(closeButton, 500)) await closeButton.click({ timeout: 1500 }).catch(() => {});
        await this.page.waitForTimeout(150).catch(() => {});
      } catch {
        await this.page.keyboard.press("Escape").catch(() => {});
      }
    }

    const unique = new Map();
    for (const payment of payments) {
      const key = [normalizeText(payment.department), normalizeText(payment.bank), normalizeText(payment.account), payment.iban, Math.round(payment.amount)].join("|");
      unique.set(key, payment);
    }
    return {
      source: "withdrawals-page",
      count: unique.size,
      payments: [...unique.values()]
    };
  }

  accountStatsUrl(pathname, departmentId = "") {
    const url = new URL(pathname, moonApiBaseUrl);
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", process.env.MOON_ACCOUNTS_LIMIT || "1000");
    if (departmentId) {
      url.searchParams.set("departmentId", departmentId);
      url.searchParams.set("department", departmentId);
    }
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  async fetchAccountStatsViaBrowser(payload) {
    const departments = payload?.data?.departments || payload?.departments || [];
    const departmentIds = departments
      .map(item => item.departmentId || item._id || item.id)
      .filter(Boolean)
      .slice(0, 4);
    const basePaths = [
      process.env.MOON_ACCOUNTS_API_PATH || "",
      "/v1/bank-accounts",
      "/v1/bank-accounts/with-balances",
      "/v1/bank-accounts/with-stats",
      "/v1/accounts",
      "/v1/accounts/bank",
      "/v1/payment-accounts",
      "/v1/department-bank-accounts"
    ].filter(Boolean);
    const departmentPaths = departmentIds.flatMap(id => [
      `/v1/departments/${id}/bank-accounts`,
      `/v1/departments/${id}/accounts`,
      `/v1/departments/${id}/payment-accounts`
    ].map(pathname => ({ pathname, departmentId: "" })));
    const candidates = [
      ...basePaths.flatMap(pathname => [
        { pathname, departmentId: "" },
        ...departmentIds.map(departmentId => ({ pathname, departmentId }))
      ]),
      ...departmentPaths
    ];
    const limit = Math.max(20, Math.min(500, numberEnv("MOON_ACCOUNT_STATS_BROWSER_LIMIT", 500)));
    const maxPages = Math.max(1, Math.min(20, numberEnv("MOON_ACCOUNT_STATS_BROWSER_PAGES", 10)));
    const seenUrls = new Set();

    for (const candidate of candidates) {
      const bundles = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const url = new URL(candidate.pathname, moonApiBaseUrl);
        url.searchParams.set("page", String(page));
        url.searchParams.set("limit", String(limit));
        if (candidate.departmentId) {
          url.searchParams.set("departmentId", candidate.departmentId);
          url.searchParams.set("department", candidate.departmentId);
        }
        url.searchParams.set("_", String(Date.now()));
        const urlString = url.toString();
        if (seenUrls.has(urlString)) break;
        seenUrls.add(urlString);
        let raw;
        try {
          raw = await this.fetchMoonJsonInBrowser(urlString);
        } catch {
          break;
        }
        const compacted = compactBankAccounts(raw, `browser:${candidate.pathname}`);
        compacted.accounts = compacted.accounts.filter(account => account.bank && account.account);
        compacted.count = compacted.accounts.length;
        if (compacted.accounts.length) bundles.push(compacted);
        const pagination = raw?.data?.pagination || raw?.pagination || compacted.pagination || {};
        const totalPages = Number(pagination.pages || pagination.totalPages || 0);
        if (!totalPages || page >= totalPages) break;
      }

      const accounts = uniqueAccounts(bundles.flatMap(bundle => bundle.accounts));
      if (accounts.length) {
        return {
          sources: [...new Set(bundles.map(bundle => bundle.source))],
          count: accounts.length,
          accounts
        };
      }
    }

    return { sources: [], count: 0, accounts: [] };
  }

  async scrapeAccountStatsFromPage() {
    await this.ensureContext();
    const cachedPath = this.accountStatsPagePath ? [this.accountStatsPagePath] : [];
    const candidatePaths = [
      ...cachedPath,
      process.env.MOON_ACCOUNTS_PAGE_PATH || "",
      "/bank-accounts",
      "/accounts",
      "/payment-accounts"
    ].filter(Boolean);
    const paths = [...new Set(candidatePaths)];

    for (const pathname of paths) {
      try {
        const pageUrl = new URL(pathname, "https://moon.aypay.co").toString();
        await this.page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await this.page.waitForTimeout(500).catch(() => {});
        const collectVisibleAccounts = async () => this.page.evaluate(() => {
          const bankNames = [
            "Akbank",
            "DenizBank",
            "Enpara",
            "Garanti BBVA",
            "Garanti",
            "Hadi",
            "Halkbank",
            "ING",
            "Kuveyt Türk",
            "QNB Finansbank",
            "QNB Finans",
            "TEB",
            "TOM",
            "VakıfBank",
            "Vakıf",
            "Yapı Kredi",
            "YapıKredi",
            "Ziraat Bankası",
            "Ziraat"
          ];
          const normalize = value => String(value || "")
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
          const parseNumber = value => {
            const clean = String(value || "")
              .replace(/[^\d,.\-]/g, "")
              .replace(/\.(?=\d{3}(\D|$))/g, "")
              .replace(",", ".");
            const number = Number(clean);
            return Number.isFinite(number) ? number : 0;
          };
          const canonicalBank = bank => {
            const text = normalize(bank).replace(/\bbankasi\b/g, "").replace(/\bbank\b/g, "").replace(/\s+/g, " ").trim();
            if (text === "qnb finans") return "qnb finansbank";
            if (text === "yapikredi") return "yapi kredi";
            if (text === "vakif") return "vakifbank";
            if (text === "ziraat") return "ziraat";
            return text;
          };
          const bankFromText = text => {
            const normalizedText = normalize(text);
            return bankNames.find(bank => {
              const canonical = canonicalBank(bank);
              return canonical && normalizedText.includes(canonical);
            }) || "";
          };
          const isStatLine = line => /(işlem|islem|hacim|min|maks|max|limit|aktif|pasif|iban|tr\d{2})/i.test(line);
          const cleanOwnerLine = line => line
            .replace(/\bŞimşek\b/gi, "")
            .replace(/\bAres\b|\bAtlas\b|\bEcem\b|\bAslan\b/gi, "")
            .replace(/\s+/g, " ")
            .trim();
          const nodes = [...document.querySelectorAll("article, tr, li, div")]
            .filter(element => {
              const text = element.innerText || "";
              return text.length > 20
                && text.length < 900
                && /\d+\s*\/\s*\d+\s*(işlem|islem)/i.test(text)
                && /hacim/i.test(text);
            });
          const seen = new Set();
          return nodes.map(element => {
            const text = element.innerText || "";
            const key = text.replace(/\s+/g, " ").trim();
            if (seen.has(key)) return null;
            seen.add(key);
            const bank = bankFromText(text);
            const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
            const owner = lines
              .map(cleanOwnerLine)
              .filter(line => line && !isStatLine(line))
              .filter(line => !bank || canonicalBank(line) !== canonicalBank(bank))
              .find(line => /[A-Za-zÇĞİÖŞÜçğıöşü]{2}/.test(line) && /\s/.test(line)) || "";
            const countMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:işlem|islem)/i);
            const volumeMatch = text.match(/Hacim\s*:?\s*₺?\s*([\d.,]+)/i);
            const minMatch = text.match(/Min\s*:?\s*₺?\s*([\d.,]+)/i);
            const maxMatch = text.match(/(?:Maks|Max)\s*:?\s*₺?\s*([\d.,]+)/i);
            return {
              bank,
              account: owner,
              depositCount: countMatch ? Number(countMatch[1]) || 0 : 0,
              depositLimit: countMatch ? Number(countMatch[2]) || 0 : 0,
              depositVolume: volumeMatch ? parseNumber(volumeMatch[1]) : 0,
              min: minMatch ? parseNumber(minMatch[1]) : 0,
              max: maxMatch ? parseNumber(maxMatch[1]) : 0,
              status: ""
            };
          }).filter(item => item && item.bank && item.account);
        });
        const accountsByKey = new Map();
        const scrollRounds = Math.max(1, numberEnv("MOON_ACCOUNT_STATS_SCROLL_ROUNDS", 35));
        let stagnantRounds = 0;
        for (let round = 0; round < scrollRounds; round += 1) {
          const batch = await collectVisibleAccounts().catch(() => []);
          let added = 0;
          for (const account of batch) {
            const key = [
              account.iban || "",
              normalizeText(account.bank),
              normalizeText(account.account)
            ].join("|");
            if (!accountsByKey.has(key) || account.depositCount || account.depositVolume) {
              if (!accountsByKey.has(key)) added += 1;
              accountsByKey.set(key, account);
            }
          }
          const moved = await this.page.evaluate(() => {
            const visible = element => {
              if (!element) return false;
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const scrollables = [...document.querySelectorAll("main, section, div, table, tbody")]
              .filter(element => visible(element) && element.scrollHeight > element.clientHeight + 40)
              .sort((a, b) => (b.clientHeight * b.clientWidth) - (a.clientHeight * a.clientWidth));
            let didMove = false;
            for (const element of scrollables.slice(0, 4)) {
              const before = element.scrollTop;
              element.scrollTop = Math.min(element.scrollHeight, before + Math.max(320, element.clientHeight * 0.85));
              if (element.scrollTop !== before) didMove = true;
            }
            const beforeWindow = window.scrollY;
            window.scrollBy(0, Math.max(450, window.innerHeight * 0.85));
            if (window.scrollY !== beforeWindow) didMove = true;
            return { didMove, y: window.scrollY, h: document.documentElement.scrollHeight };
          }).catch(() => ({ didMove: false }));
          if (!added && !moved.didMove) stagnantRounds += 1;
          else stagnantRounds = 0;
          if (stagnantRounds >= 3) break;
          await this.page.waitForTimeout(180).catch(() => {});
        }
        const accounts = [...accountsByKey.values()];
        if (accounts.length) {
          this.accountStatsPagePath = pathname;
          return {
            sources: [`page:${pathname}`],
            count: accounts.length,
            accounts: uniqueAccounts(accounts)
          };
        }
      } catch {
        // Try the next page candidate.
      }
    }

    return { sources: [], count: 0, accounts: [] };
  }

  async fetchAccountStatsBundle(payload) {
    const cacheMs = Math.max(1000, numberEnv("MOON_ACCOUNT_STATS_CACHE_MS", 10000));
    if (this.lastAccountStatsBundle && Date.now() - this.lastAccountStatsAt < cacheMs) {
      return this.lastAccountStatsBundle;
    }
    if (Date.now() < this.accountStatsDisabledUntil) {
      return this.lastAccountStatsBundle || { sources: [], count: 0, accounts: [] };
    }

    const browserStats = await this.fetchAccountStatsViaBrowser(payload).catch(() => null);
    if (browserStats?.accounts?.length) {
      this.lastAccountStatsBundle = browserStats;
      this.lastAccountStatsAt = Date.now();
      return browserStats;
    }

    const departments = payload?.data?.departments || payload?.departments || [];
    const departmentIds = departments
      .map(item => item.departmentId || item._id || item.id)
      .filter(Boolean)
      .slice(0, 4);
    const basePaths = [
      "/v1/bank-accounts",
      "/v1/bank-accounts/with-balances",
      "/v1/bank-accounts/with-stats",
      "/v1/accounts",
      "/v1/accounts/bank",
      "/v1/payment-accounts",
      "/v1/department-bank-accounts"
    ];
    const departmentPaths = departmentIds.flatMap(id => [
      `/v1/departments/${id}/bank-accounts`,
      `/v1/departments/${id}/accounts`,
      `/v1/departments/${id}/payment-accounts`
    ].map(pathname => ({ pathname, departmentId: "" })));
    const discoveredIsFresh = this.accountStatsCandidates.length && Date.now() - this.accountStatsLastDiscovery < 300000;
    const discoveryPool = [
      ...basePaths.flatMap(pathname => [
        { pathname, departmentId: "" },
        ...departmentIds.map(departmentId => ({ pathname, departmentId }))
      ]),
      ...departmentPaths
    ];
    let wrappedDiscovery = false;
    let candidates = this.accountStatsCandidates;
    if (!discoveredIsFresh) {
      const perTick = Math.max(1, Math.min(4, numberEnv("MOON_ACCOUNT_STATS_PROBES_PER_TICK", 3)));
      const start = discoveryPool.length ? this.accountStatsProbeIndex % discoveryPool.length : 0;
      candidates = Array.from({ length: Math.min(perTick, discoveryPool.length) }, (_, offset) => {
        return discoveryPool[(start + offset) % discoveryPool.length];
      });
      const nextIndex = start + candidates.length;
      wrappedDiscovery = discoveryPool.length > 0 && nextIndex >= discoveryPool.length;
      this.accountStatsProbeIndex = discoveryPool.length ? nextIndex % discoveryPool.length : 0;
    }
    const seen = new Set();
    const bundles = [];
    for (const candidate of candidates) {
      const url = this.accountStatsUrl(candidate.pathname, candidate.departmentId);
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const raw = await this.fetchMoonJson(url);
        const compacted = compactBankAccounts(raw, candidate.pathname);
        compacted.accounts = compacted.accounts.filter(account => account.bank && account.account);
        compacted.count = compacted.accounts.length;
        if (compacted.accounts.length) {
          bundles.push(compacted);
          if (!discoveredIsFresh) {
            this.accountStatsCandidates = [candidate];
            this.accountStatsLastDiscovery = Date.now();
            break;
          }
        }
      } catch {
        // Moon installations may name this endpoint differently; ignore misses.
      }
    }

    if (!bundles.length) {
      const scraped = await this.scrapeAccountStatsFromPage();
      if (scraped.accounts.length) {
        this.lastAccountStatsBundle = scraped;
        this.lastAccountStatsAt = Date.now();
        return scraped;
      }
      if (discoveredIsFresh) {
        this.accountStatsCandidates = [];
        this.accountStatsLastDiscovery = 0;
        this.accountStatsDisabledUntil = Date.now() + 10000;
      } else {
        this.accountStatsDisabledUntil = wrappedDiscovery ? Date.now() + 60000 : 0;
      }
      return { sources: [], count: 0, accounts: [] };
    }

    const result = {
      sources: [...new Set(bundles.map(bundle => bundle.source))],
      accounts: uniqueAccounts(bundles.flatMap(bundle => bundle.accounts))
    };
    result.count = result.accounts.length;
    this.lastAccountStatsBundle = result;
    this.lastAccountStatsAt = Date.now();
    return result;
  }

  async ensureLoggedIn() {
    try {
      const payload = await this.fetchLivePayload();
      this.heartbeatMoonPage({ force: !this.lastHeartbeatMs }).catch(() => {});
      return payload;
    } catch {
      // Fall through to normal browser login.
    }

    const username = process.env.MOON_USERNAME;
    const password = process.env.MOON_PASSWORD;
    const totpSecret = process.env.MOON_TOTP_SECRET;
    if (!username || !password || !totpSecret) {
      throw new Error("MOON_USERNAME, MOON_PASSWORD ve MOON_TOTP_SECRET gerekli.");
    }

    await this.ensureContext();
    this.loginAttempts += 1;
    await this.page.goto(moonLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    const usernameInput = this.page.locator('#username, input[name="username"], input[autocomplete="username"]').first();
    const passwordInput = this.page.locator('#password, input[name="password"], input[type="password"]').first();
    if (await visible(usernameInput, 5000)) {
      await usernameInput.fill(username);
      await passwordInput.fill(password);
      await clickLikelySubmit(this.page);
    }

    await this.fillTotpIfNeeded();
    await this.waitForMoonSession();
    await this.page.goto(moonHomeUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const payload = await this.fetchLivePayload();
    status.lastLoginAt = new Date().toISOString();
    return payload;
  }

  async waitForMoonSession() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
      const cookies = await this.context.cookies(["https://moon.aypay.co", "https://moon-api.aypay.co"]);
      if (cookies.some(cookie => cookie.name === "session_id")) return true;
      if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 100 }).catch(() => false)) break;
      await delay(500);
    }
    return false;
  }

  async fillTotpIfNeeded() {
    const inputs = this.page.locator('input.code-input, input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (!(await waitVisible(inputs.first(), 10000))) return;

    const secret = await this.resolveTotpSecret();
    await this.typeTotpCode(inputs, secret);
    await clickLikelySubmit(this.page);
    await delay(1600);

    if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false)) {
      await this.waitForFreshTotpWindow();
      await this.typeTotpCode(inputs, secret);
      await clickLikelySubmit(this.page);
      await delay(1600);
    }

    if (await this.page.getByText(/invalid\s*2fa|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false)) {
      if (await this.tryBackupCode()) return;
      throw new Error("Moon 2FA kodu geçersiz. MOON_TOTP_SECRET doğru secret olmalı veya MOON_BACKUP_CODE girilmeli.");
    }
  }

  async waitForFreshTotpWindow() {
    const { stepSeconds } = totpOptions();
    const secondsLeft = stepSeconds - (Math.floor(Date.now() / 1000) % stepSeconds);
    if (secondsLeft <= 10) await delay((secondsLeft + 1) * 1000);
  }

  async typeTotpCode(inputs, secret) {
    await this.waitForFreshTotpWindow();
    const { algorithm, stepSeconds, digits } = totpOptions();
    const code = generateTotp(secret, Date.now(), stepSeconds, digits, algorithm);
    const count = await inputs.count();
    if (count >= 6) {
      for (let index = 0; index < count; index += 1) {
        await inputs.nth(index).fill("").catch(() => {});
      }
      await inputs.first().click();
      await this.page.keyboard.type(code, { delay: 70 });
    } else {
      await inputs.first().fill(code);
    }
  }

  async tryBackupCode() {
    const backupCode = process.env.MOON_BACKUP_CODE || process.env.MOON_2FA_BACKUP_CODE;
    if (!backupCode) return false;

    const backupButton = this.page.getByText(/yedek kod|backup code/i).first();
    if (!(await backupButton.isVisible({ timeout: 1000 }).catch(() => false))) return false;
    await backupButton.click();
    await delay(500);

    const input = this.page.locator('input:not(.code-input), textarea, input.code-input').first();
    if (!(await waitVisible(input, 5000))) return false;
    await input.fill(String(backupCode));
    await clickLikelySubmit(this.page);
    await delay(1600);
    return !(await this.page.getByText(/invalid|geçersiz|gecersiz/i).first().isVisible({ timeout: 500 }).catch(() => false));
  }

  async resolveTotpSecret() {
    const setupSecret = await this.readSetupTotpSecret();
    if (setupSecret) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this.totpSecretPath, setupSecret, "utf8");
      return setupSecret;
    }

    if (process.env.MOON_TOTP_SECRET) return process.env.MOON_TOTP_SECRET;

    if (fs.existsSync(this.totpSecretPath)) {
      const saved = fs.readFileSync(this.totpSecretPath, "utf8").trim();
      if (saved) return saved;
    }

    return "";
  }

  async readSetupTotpSecret() {
    try {
      const { valueSecrets, textSecrets } = await this.page.evaluate(() => {
        const cleanMatches = raw => {
          const text = String(raw || "").replace(/\s+/g, "");
          return text.match(/[A-Z2-7]{24,}/g) || [];
        };
        return {
          valueSecrets: [...document.querySelectorAll("input, textarea")]
            .flatMap(element => cleanMatches(element.value)),
          textSecrets: [...document.querySelectorAll("code, pre, span, p")]
            .flatMap(element => cleanMatches(element.textContent))
        };
      });
      const inputSecret = [...new Set(valueSecrets)]
        .filter(secret => base32LooksUsable(secret))
        .sort((a, b) => b.length - a.length)[0] || "";
      if (inputSecret) return inputSecret;
      return [...new Set(textSecrets)]
        .filter(secret => base32LooksUsable(secret))
        .sort((a, b) => b.length - a.length)[0] || "";
    } catch {
      return "";
    }
  }

  startEnrichmentRefresh(payload, { force = false } = {}) {
    const stale = Date.now() - this.lastEnrichmentRefreshAt >= this.enrichmentRefreshMs;
    if (!force && !stale) return this.enrichmentRefreshPromise;
    if (this.enrichmentRefreshPromise) return this.enrichmentRefreshPromise;

    this.enrichmentRefreshPromise = this.refreshEnrichmentBundles(payload)
      .catch(error => {
        status.lastError = error.message;
        return null;
      })
      .finally(() => {
        this.enrichmentRefreshPromise = null;
      });
    return this.enrichmentRefreshPromise;
  }

  startDepositBackgroundRefresh({ force = false } = {}) {
    if (!this.depositBackgroundEnabled) {
      status.lastDepositRefreshStatus = "disabled";
      return null;
    }
    const stale = Date.now() - this.lastFullDepositsAt >= this.depositBackgroundRefreshMs;
    if (!force && !stale) return this.depositBackgroundPromise;
    if (this.depositBackgroundPromise) return this.depositBackgroundPromise;

    status.lastDepositRefreshStatus = "running";
    status.nextDepositRefreshAt = new Date(Date.now() + this.depositBackgroundRefreshMs).toISOString();
    this.depositBackgroundPromise = this.fetchApprovedDeposits({
      paginate: true,
      maxPages: this.depositBackgroundMaxPages
    })
      .then(bundle => {
        const safeBundle = bundle || compactTransactions(null, "deposit");
        const refreshedAt = new Date().toISOString();
        this.lastFullDepositsBundle = {
          ...safeBundle,
          source: "approved-deposits-background",
          refreshedAt
        };
        this.lastFullDepositsAt = Date.now();
        this.lastTransactionsBundle = stableTransactionBundle({
          ...this.lastTransactionsBundle,
          deposits: this.lastFullDepositsBundle
        });
        status.lastDepositRefreshAt = refreshedAt;
        status.lastDepositRefreshStatus = "ok";
        status.lastDepositRefreshError = "";
        status.lastDepositPagesFetched = Number(safeBundle?.pagesFetched || 0);
        status.lastDepositCount = Number(safeBundle?.count || 0);
        status.lastDepositTotal = Number(safeBundle?.total || 0);
        return this.lastFullDepositsBundle;
      })
      .catch(error => {
        status.lastDepositRefreshStatus = "error";
        status.lastDepositRefreshError = error.message;
        return this.lastFullDepositsBundle;
      })
      .finally(() => {
        this.depositBackgroundPromise = null;
        status.nextDepositRefreshAt = new Date(Date.now() + this.depositBackgroundRefreshMs).toISOString();
      });
    return this.depositBackgroundPromise;
  }

  startDepositRequestRiskRefresh({ force = false } = {}) {
    const stale = Date.now() - this.lastDepositRequestRiskAt >= this.depositRequestRiskRefreshMs;
    if (!force && !stale) return this.depositRequestRiskPromise;
    if (this.depositRequestRiskPromise) return this.depositRequestRiskPromise;

    this.depositRequestRiskPromise = Promise.all([
      this.fetchApprovedDeposits({ paginate: false, maxPages: 1 }),
      this.fetchTransactionPages("deposit", "pending,assigned", { paginate: false, maxPages: 1 })
    ])
      .then(([approved, active]) => {
        this.lastDepositRequestRisk = buildDepositRequestRisk(approved, active, Date.now(), this.lastDepositProfiles);
        this.lastDepositRequestRiskAt = Date.now();
        return this.lastDepositRequestRisk;
      })
      .catch(error => {
        return this.lastDepositRequestRisk;
      })
      .finally(() => {
        this.depositRequestRiskPromise = null;
      });
    return this.depositRequestRiskPromise;
  }

  startDepositProfilesRefresh({ force = false } = {}) {
    const stale = Date.now() - this.lastDepositProfilesAt >= this.depositProfilesRefreshMs;
    if (!force && !stale) return this.depositProfilesPromise;
    if (this.depositProfilesPromise) return this.depositProfilesPromise;
    this.depositProfilesPromise = this.fetchTransactionPages("deposit", "pending,assigned", {
      paginate: false,
      maxPages: 1
    })
      .then(async active => {
        const identities = new Map();
        for (const transaction of transactionArray(active)) {
          const userKey = normalizeText(transaction?.user);
          if (!userKey || identities.has(userKey)) continue;
          identities.set(userKey, {
            user: transaction.user,
            userId: transaction.userId,
            userUsername: transaction.userUsername
          });
        }
        if (!identities.size) return null;
        const now = new Date();
        const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const dateParam = value => value.toISOString().slice(0, 10);
        const histories = await Promise.all([...identities.values()].map(identity => {
          const params = {
            startDate: dateParam(cutoff),
            endDate: dateParam(now),
            dateField: "createdAt",
            customerId: identity.userId,
            customerUsername: identity.userId ? "" : identity.userUsername,
            customerName: identity.userId || identity.userUsername ? "" : identity.user
          };
          return this.fetchTransactionPages("deposit", "", {
            paginate: true,
            maxPages: this.depositProfilesMaxPages,
            params
          }).then(history => ({ history, identity }));
        }));
        const exactTransactions = [];
        for (const { history, identity } of histories) {
          for (const transaction of transactionArray(history)) {
            const idMatch = identity.userId && transaction.userId && String(identity.userId) === String(transaction.userId);
            const usernameMatch = identity.userUsername && transaction.userUsername
              && normalizeText(identity.userUsername) === normalizeText(transaction.userUsername);
            const nameMatch = normalizeText(identity.user) === normalizeText(transaction.user);
            if (idMatch || usernameMatch || nameMatch) exactTransactions.push(transaction);
          }
        }
        return { data: { transactions: exactTransactions } };
      })
      .then(history => {
        if (!history) return this.lastDepositProfiles;
        this.lastDepositProfiles = buildDepositProfiles(history, Date.now());
        this.lastDepositProfilesAt = Date.now();
        return this.lastDepositProfiles;
      })
      .catch(() => this.lastDepositProfiles)
      .finally(() => { this.depositProfilesPromise = null; });
    return this.depositProfilesPromise;
  }

  async refreshEnrichmentBundles(payload) {
    const transactions = await this.fetchTransactionBundle()
      .catch(error => {
        if (this.lastTransactionsBundle) return stableTransactionBundle(this.lastTransactionsBundle);
        throw error;
      });
    this.lastTransactionsBundle = stableTransactionBundle({
      ...transactions,
      deposits: this.lastFullDepositsBundle || transactions.deposits,
      withdrawalPartials: this.lastWithdrawalPartialsBundle || stableTransactionBundle().withdrawalPartials
    });

    const [accountStats, withdrawalPartials] = await Promise.all([
      this.fetchAccountStatsBundle(payload).catch(() => this.lastAccountStatsBundle || { sources: [], count: 0, accounts: [] }),
      this.fetchWithdrawalPartialBundle(transactions).catch(error => this.lastWithdrawalPartialsBundle || ({
        source: "transaction-detail",
        count: 0,
        error: error.message,
        payments: []
      }))
    ]);

    this.lastAccountStatsBundle = accountStats;
    this.lastAccountStatsAt = Date.now();
    this.lastWithdrawalPartialsBundle = withdrawalPartials;
    this.lastWithdrawalPartialsAt = Date.now();
    this.lastTransactionsBundle = stableTransactionBundle({
      ...transactions,
      deposits: this.lastFullDepositsBundle || transactions.deposits,
      withdrawalPartials
    });
    this.lastEnrichmentRefreshAt = Date.now();
    return {
      transactions: this.lastTransactionsBundle,
      accountStats: this.lastAccountStatsBundle
    };
  }

  async enrichPayload(payload) {
    const capturedAt = new Date().toISOString();
    const seq = Date.now();
    status.seq = seq;
    status.lastPayloadCapturedAt = capturedAt;
    const hasWarmExtras = Boolean(this.lastTransactionsBundle || this.lastAccountStatsBundle || this.lastWithdrawalPartialsBundle);
    const refresh = this.startEnrichmentRefresh(payload, { force: !hasWarmExtras });
    const depositRefresh = this.startDepositBackgroundRefresh({ force: !this.lastFullDepositsBundle });
    if (depositRefresh) depositRefresh.catch(() => {});
    const depositRiskRefresh = this.startDepositRequestRiskRefresh({ force: !this.lastDepositRequestRisk });
    const depositProfilesRefresh = this.startDepositProfilesRefresh({ force: !this.lastDepositProfiles });
    if (!this.lastDepositProfiles && depositProfilesRefresh) {
      await Promise.race([depositProfilesRefresh, delay(1200)]).catch(() => {});
    }
    if (!this.lastDepositRequestRisk && depositRiskRefresh) {
      await Promise.race([depositRiskRefresh, delay(1200)]).catch(() => {});
    }
    if (this.initialEnrichmentWaitMs > 0 && !hasWarmExtras && refresh) {
      await Promise.race([refresh, delay(this.initialEnrichmentWaitMs)]).catch(() => {});
    }
    const transactions = stableTransactionBundle(this.lastTransactionsBundle);
    if (this.lastFullDepositsBundle) transactions.deposits = this.lastFullDepositsBundle;
    transactions.withdrawalPartials = this.lastWithdrawalPartialsBundle || transactions.withdrawalPartials;
    const liveTransactions = boolEnv("MOON_LIVE_SLIM_TRANSACTIONS", true)
      ? slimTransactionBundle(transactions)
      : transactions;
    const depositRequestRisk = buildDepositRequestRisk(
      this.lastFullDepositsBundle || transactions.deposits,
      transactions.activeDeposits,
      Date.now(),
      this.lastDepositProfiles
    );
    const accountStats = this.lastAccountStatsBundle || { sources: [], count: 0, accounts: [] };
    return {
      ...payload,
      bozokLive: {
        ...(payload.bozokLive || {}),
        capturedAt,
        seq,
        deviceName: this.deviceName,
        source: "playwright",
        transport: "moon-automation",
        transactions: liveTransactions,
        depositRequestRisk,
        depositProfiles: this.lastDepositProfiles,
        transactionArchive: boolEnv("MOON_LIVE_SLIM_TRANSACTIONS", true) ? "summary-sampled" : "full",
        accountStats
      }
    };
  }

  async pushPayload(payload) {
    const rememberPushResult = result => {
      status.lastPushAt = new Date().toISOString();
      if (result?.accepted === false || result?.skipped) {
        status.lastSkippedAt = status.lastPushAt;
      } else {
        status.lastAcceptedAt = status.lastPushAt;
      }
      return result;
    };

    if (this.onPayload) {
      const result = await this.onPayload(payload);
      return rememberPushResult(result);
    }

    const base = process.env.BOZOK_PUBLIC_URL
      || process.env.DASHBOARD_STATE_URL
      || "http://localhost:8787";
    const response = await fetch(new URL("/api/moon-cache", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Bozok cache POST ${response.status}`);
    const result = await response.json();
    return rememberPushResult(result);
  }

  async runOnce() {
    await this.ensureContext();
    const payload = await this.ensureLoggedIn();
    const enriched = await this.enrichPayload(payload);
    const pushed = await this.pushPayload(enriched);
    this.heartbeatMoonPage().catch(() => {});
    return { payload: enriched, pushed };
  }
}

async function runMoonAutomationOnce(options = {}) {
  loadEnv();
  const worker = new MoonAutomation(options);
  try {
    return await worker.runOnce();
  } finally {
    await worker.stop();
  }
}

async function startMoonAutomation(options = {}) {
  loadEnv();
  if (singleton) return singleton;
  singleton = new MoonAutomation(options);
  await singleton.start();
  return singleton;
}

function moonAutomationStatus() {
  return { ...status };
}

async function cli() {
  loadEnv();
  const mode = process.argv[2] || "once";
  if (mode === "worker") {
    await startMoonAutomation();
    console.log("Moon automation worker çalışıyor.");
    return;
  }
  const result = await runMoonAutomationOnce();
  console.log(JSON.stringify({
    success: true,
    pushed: result.pushed,
    capturedAt: result.payload.bozokLive.capturedAt,
    deviceName: result.payload.bozokLive.deviceName
  }, null, 2));
}

if (require.main === module) {
  cli().catch(error => {
    console.error(`Moon automation hatası: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDepositRequestRisk,
  buildDepositProfiles,
  generateTotp,
  runMoonAutomationOnce,
  startMoonAutomation,
  moonAutomationStatus
};

function base32LooksUsable(secret) {
  try {
    return base32Decode(secret).length >= 10;
  } catch {
    return false;
  }
}
