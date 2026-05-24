const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FOLDER = "BozokMerkez";
const DEFAULT_SYNC_MIN_MS = 500;

let stateTimer = null;
let moonTimer = null;
let pendingState = null;
let pendingMoon = null;

const runtime = {
  lastStateWriteAt: "",
  lastMoonWriteAt: "",
  lastReadAt: "",
  lastError: ""
};

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function centerEnabled() {
  return envFlag("ONEDRIVE_CENTER_ENABLED");
}

function centerPrimaryEnabled() {
  return centerEnabled() && envFlag("ONEDRIVE_CENTER_PRIMARY");
}

function syncMinMs() {
  return Math.max(100, Number(process.env.ONEDRIVE_SYNC_MIN_MS || DEFAULT_SYNC_MIN_MS));
}

function defaultCenterDir() {
  const oneDrive = process.env.ONEDRIVE || process.env.OneDrive || "";
  if (oneDrive) return path.join(oneDrive, DEFAULT_FOLDER);
  if (process.env.USERPROFILE) return path.join(process.env.USERPROFILE, "OneDrive", DEFAULT_FOLDER);
  return "";
}

function centerDir() {
  return process.env.ONEDRIVE_CENTER_DIR || defaultCenterDir();
}

function centerStatus() {
  const dir = centerDir();
  return {
    enabled: centerEnabled(),
    primary: centerPrimaryEnabled(),
    dir,
    exists: Boolean(dir && fs.existsSync(dir)),
    lastStateWriteAt: runtime.lastStateWriteAt,
    lastMoonWriteAt: runtime.lastMoonWriteAt,
    lastReadAt: runtime.lastReadAt,
    lastError: runtime.lastError
  };
}

function setError(error) {
  runtime.lastError = error?.message || String(error || "");
}

function ensureDir() {
  const dir = centerDir();
  if (!centerEnabled()) return "";
  if (!dir) throw new Error("ONEDRIVE_CENTER_DIR bulunamadi.");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeTextAtomic(filePath, text) {
  const tempPath = `${filePath}.tmp`;
  const body = String(filePath).toLowerCase().endsWith(".csv")
    ? `\ufeff${String(text || "").replace(/^\ufeff/, "")}`
    : text;
  fs.writeFileSync(tempPath, body, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function numeric(value) {
  if (typeof value === "number") return value;
  const cleaned = String(value ?? "")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  return Number(cleaned) || 0;
}

function thousandFloor(value) {
  const amount = Math.floor(Number(value) || 0);
  return amount >= 1000 ? Math.floor(amount / 1000) * 1000 : 0;
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\r\n;]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function csv(rows) {
  return `${rows.map(row => row.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

function transactionItems(payload, key) {
  const source = payload?.bozokLive?.transactions?.[key];
  if (Array.isArray(source)) return source;
  return source?.data?.transactions || source?.transactions || source?.data || [];
}

function transactionAmount(item) {
  return numeric(
    item.amount
    ?? item.requestAmount
    ?? item.requestedAmount
    ?? item.approvedAmount
    ?? item.totalAmount
    ?? item.price
    ?? item.value
  );
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

function liveTransactionTotal(payload, key, reportDate) {
  const items = transactionItems(payload, key);
  if (!items.length) return null;
  const datedItems = reportDate ? items.filter(item => !transactionDate(item) || transactionDate(item) === reportDate) : items;
  if (!datedItems.length) return null;
  return datedItems.reduce((sum, item) => sum + transactionAmount(item), 0);
}

function firstLiveTotal(payload, keys, reportDate) {
  for (const key of keys) {
    const total = liveTransactionTotal(payload, key, reportDate);
    if (total !== null) return total;
  }
  return null;
}

function normalizeMoonReport(payload) {
  const departments = payload?.data?.departments || payload?.departments || [];
  const selected = departments[0];
  if (!selected) return null;
  const daily = selected.balances?.dailyBalance || {};
  const date = String(daily.date || selected.updatedAt || new Date().toISOString()).slice(0, 10);
  const liveDepositTotal = firstLiveTotal(payload, ["deposits", "activeDeposits"], date);
  const liveWithdrawalTotal = firstLiveTotal(payload, ["withdrawals", "activeWithdrawals"], date);
  return {
    department: selected.departmentName || selected.name || "-",
    date,
    devir: thousandFloor(daily.openingBalance),
    yatirim: thousandFloor(liveDepositTotal ?? daily.depositAmount ?? daily.totalDepositAmount),
    cekim: thousandFloor(liveWithdrawalTotal ?? daily.withdrawalAmount),
    komisyon: thousandFloor(daily.totalCommission),
    kasa: thousandFloor(daily.closingBalance ?? selected.kasaBalance),
    liveCapturedAt: payload?.bozokLive?.capturedAt || "",
    liveSeq: payload?.bozokLive?.seq || "",
    liveDeviceName: payload?.bozokLive?.deviceName || "",
    savedAt: new Date().toISOString()
  };
}

function liveRows(report) {
  const safe = report || {};
  return [
    ["departman", "tarih", "devir", "yatirim", "cekim", "yatirim_kom", "kasa", "kaynak", "son_guncelleme"],
    [
      safe.department || "",
      safe.date || "",
      numeric(safe.devir),
      numeric(safe.yatirim),
      numeric(safe.cekim),
      numeric(safe.komisyon),
      numeric(safe.kasa),
      safe.liveDeviceName || safe.source || "",
      safe.savedAt || safe.liveCapturedAt || new Date().toISOString()
    ]
  ];
}

function vaultRows(state) {
  const rows = [["kasa", "kasa_adi", "set", "banka", "bakiye", "toplama_giren", "arkaplan", "stil"]];
  for (const [vaultKey, vault] of Object.entries(state?.vaults || {})) {
    for (const [owner, accounts] of Object.entries(vault.sets || {})) {
      for (const account of accounts || []) {
        const amount = numeric(account[1]);
        rows.push([
          vaultKey,
          vault.title || "",
          owner,
          account[0] || "",
          amount,
          thousandFloor(amount),
          vault.bgColor || "",
          state?.vaultStyle || ""
        ]);
      }
    }
  }
  return rows;
}

function reconciliationRows(state) {
  return [
    ["aciklama", "grup", "gelir", "kasa", "devir_kom_giderler", "otomatik"],
    ...(state?.reconciliationRows || []).map(row => [
      row.label || "",
      row.group || "",
      numeric(row.gelir),
      numeric(row.kasa),
      numeric(row.devir),
      row.auto ? JSON.stringify(row.auto) : ""
    ])
  ];
}

function blockRows(state) {
  return [
    ["aciklama", "tutar", "not"],
    ...(state?.blockRows || []).map(row => [
      row.name || "",
      numeric(row.amount),
      row.note || ""
    ])
  ];
}

function writeDashboardFiles(state) {
  if (!centerEnabled() || !state) return { skipped: true };
  const dir = ensureDir();
  writeJsonAtomic(path.join(dir, "bozok-state.json"), state);
  writeTextAtomic(path.join(dir, "kasalar.csv"), csv(vaultRows(state)));
  writeTextAtomic(path.join(dir, "formul.csv"), csv(reconciliationRows(state)));
  writeTextAtomic(path.join(dir, "blokeler.csv"), csv(blockRows(state)));
  if (state.latestReport) {
    writeTextAtomic(path.join(dir, "bozok-live.csv"), csv(liveRows(state.latestReport)));
  }
  runtime.lastStateWriteAt = new Date().toISOString();
  runtime.lastError = "";
  return { success: true, dir };
}

function writeMoonFiles(payload) {
  if (!centerEnabled() || !payload) return { skipped: true };
  const dir = ensureDir();
  const record = { updatedAt: new Date().toISOString(), payload };
  writeJsonAtomic(path.join(dir, "moon-cache.json"), record);
  const report = normalizeMoonReport(payload);
  if (report) writeTextAtomic(path.join(dir, "bozok-live.csv"), csv(liveRows(report)));
  runtime.lastMoonWriteAt = new Date().toISOString();
  runtime.lastError = "";
  return { success: true, dir };
}

function scheduleStateWrite() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const state = pendingState;
    pendingState = null;
    try {
      writeDashboardFiles(state);
      if (pendingState) scheduleStateWrite();
    } catch (error) {
      setError(error);
    }
  }, syncMinMs());
}

function scheduleMoonWrite() {
  if (moonTimer) return;
  moonTimer = setTimeout(() => {
    moonTimer = null;
    const payload = pendingMoon;
    pendingMoon = null;
    try {
      writeMoonFiles(payload);
      if (pendingMoon) scheduleMoonWrite();
    } catch (error) {
      setError(error);
    }
  }, syncMinMs());
}

function syncDashboardStateToOneDrive(state, options = {}) {
  if (!centerEnabled()) return Promise.resolve({ skipped: true });
  if (options.force) {
    try {
      return Promise.resolve(writeDashboardFiles(state));
    } catch (error) {
      setError(error);
      return Promise.reject(error);
    }
  }
  pendingState = state;
  scheduleStateWrite();
  return Promise.resolve({ queued: true });
}

function syncMoonCacheToOneDrive(payload, options = {}) {
  if (!centerEnabled()) return Promise.resolve({ skipped: true });
  if (options.force) {
    try {
      return Promise.resolve(writeMoonFiles(payload));
    } catch (error) {
      setError(error);
      return Promise.reject(error);
    }
  }
  pendingMoon = payload;
  scheduleMoonWrite();
  return Promise.resolve({ queued: true });
}

function readDashboardStateFromOneDrive() {
  if (!centerEnabled()) return null;
  const dir = centerDir();
  if (!dir) return null;
  const state = readJson(path.join(dir, "bozok-state.json"), null);
  if (!state?.vaults) return null;
  runtime.lastReadAt = new Date().toISOString();
  runtime.lastError = "";
  return state;
}

function readMoonCacheFromOneDrive() {
  if (!centerEnabled()) return null;
  const dir = centerDir();
  if (!dir) return null;
  const record = readJson(path.join(dir, "moon-cache.json"), null);
  return record?.payload ? record : null;
}

module.exports = {
  centerEnabled,
  centerPrimaryEnabled,
  centerStatus,
  syncDashboardStateToOneDrive,
  syncMoonCacheToOneDrive,
  readDashboardStateFromOneDrive,
  readMoonCacheFromOneDrive
};
