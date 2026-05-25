const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_SYNC_MIN_MS = 5_000;

let tokenCache = { value: "", expiresAt: 0 };
let workbookCache = null;
let stateTimer = null;
let moonTimer = null;
let pendingState = null;
let pendingMoon = null;
let stateSyncInFlight = false;
let moonSyncInFlight = false;

const excelRuntime = {
  lastStateSyncAt: "",
  lastMoonSyncAt: "",
  lastReadAt: "",
  lastError: "",
  lastWorkbookMode: ""
};

function envFlag(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function excelCenterEnabled() {
  return envFlag("EXCEL_CENTER_ENABLED");
}

function excelPrimaryEnabled() {
  return excelCenterEnabled() && envFlag("EXCEL_CENTER_PRIMARY");
}

function kasaDirectEnabled() {
  return excelCenterEnabled() && envFlag("EXCEL_KASA_DIRECT_ENABLED");
}

function syncMinMs() {
  return Math.max(1000, Number(process.env.EXCEL_SYNC_MIN_MS || DEFAULT_SYNC_MIN_MS));
}

function timeMs(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function excelStatus() {
  return {
    enabled: excelCenterEnabled(),
    primary: excelPrimaryEnabled(),
    hasClientId: Boolean(process.env.MS_CLIENT_ID),
    hasRefreshToken: Boolean(process.env.MS_REFRESH_TOKEN),
    hasWorkbookShareUrl: Boolean(process.env.EXCEL_WORKBOOK_SHARE_URL),
    hasWorkbookDriveItem: Boolean(process.env.EXCEL_WORKBOOK_DRIVE_ID && process.env.EXCEL_WORKBOOK_ITEM_ID),
    kasaDirect: kasaDirectEnabled(),
    kasaSheet: process.env.EXCEL_KASA_TARGET_SHEET || "",
    lastStateSyncAt: excelRuntime.lastStateSyncAt,
    lastMoonSyncAt: excelRuntime.lastMoonSyncAt,
    lastReadAt: excelRuntime.lastReadAt,
    lastError: excelRuntime.lastError,
    workbookMode: excelRuntime.lastWorkbookMode
  };
}

function setExcelError(error) {
  excelRuntime.lastError = error?.message || String(error || "");
}

function configured() {
  return excelCenterEnabled()
    && Boolean(process.env.MS_CLIENT_ID)
    && Boolean(process.env.MS_REFRESH_TOKEN)
    && Boolean(process.env.EXCEL_WORKBOOK_SHARE_URL || (process.env.EXCEL_WORKBOOK_DRIVE_ID && process.env.EXCEL_WORKBOOK_ITEM_ID));
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") body.set(key, String(value));
  }
  return body;
}

async function getAccessToken() {
  if (tokenCache.value && tokenCache.expiresAt - TOKEN_MARGIN_MS > Date.now()) return tokenCache.value;
  if (!configured()) throw new Error("Excel center env eksik: MS_CLIENT_ID, MS_REFRESH_TOKEN ve workbook bilgisi gerekli.");

  const tenant = process.env.MS_TENANT_ID || "consumers";
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: process.env.MS_REFRESH_TOKEN,
      scope: process.env.MS_GRAPH_SCOPES || "offline_access Files.ReadWrite User.Read"
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Microsoft token hatasi ${response.status}: ${payload.error_description || payload.error || "bilinmiyor"}`);
  }

  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + (Number(payload.expires_in || 3600) * 1000)
  };
  return tokenCache.value;
}

async function graphFetch(pathname, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(pathname.startsWith("http") ? pathname : `${GRAPH_ROOT}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 204) return null;
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Microsoft Graph ${response.status}: ${payload?.error?.message || text || "bilinmiyor"}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function base64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function resolveWorkbook() {
  if (workbookCache) return workbookCache;

  if (process.env.EXCEL_WORKBOOK_DRIVE_ID && process.env.EXCEL_WORKBOOK_ITEM_ID) {
    excelRuntime.lastWorkbookMode = "drive-item";
    workbookCache = {
      driveId: process.env.EXCEL_WORKBOOK_DRIVE_ID,
      itemId: process.env.EXCEL_WORKBOOK_ITEM_ID
    };
    return workbookCache;
  }

  const shareUrl = process.env.EXCEL_WORKBOOK_SHARE_URL;
  if (!shareUrl) throw new Error("EXCEL_WORKBOOK_SHARE_URL veya drive/item bilgisi gerekli.");

  excelRuntime.lastWorkbookMode = "share-url";
  const item = await graphFetch(`/shares/u!${base64Url(shareUrl)}/driveItem`);
  const driveId = item?.parentReference?.driveId;
  const itemId = item?.id;
  if (!driveId || !itemId) throw new Error("OneDrive workbook driveId/itemId bulunamadi.");
  workbookCache = { driveId, itemId };
  return workbookCache;
}

async function workbookPath() {
  const { driveId, itemId } = await resolveWorkbook();
  return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
}

function sheetPath(base, sheetName) {
  return `${base}/workbook/worksheets/${encodeURIComponent(sheetName)}`;
}

function rangePath(base, sheetName, address) {
  return `${sheetPath(base, sheetName)}/range(address='${encodeURIComponent(address)}')`;
}

async function ensureWorksheet(base, sheetName) {
  try {
    await graphFetch(sheetPath(base, sheetName));
  } catch (error) {
    if (error.status !== 404) throw error;
    await graphFetch(`${base}/workbook/worksheets/add`, {
      method: "POST",
      body: JSON.stringify({ name: sheetName })
    });
  }
}

async function listWorksheets(base) {
  const payload = await graphFetch(`${base}/workbook/worksheets`);
  return payload?.value || [];
}

async function targetKasaSheetName(base) {
  const configuredSheet = String(process.env.EXCEL_KASA_TARGET_SHEET || "").trim();
  if (configuredSheet) return configuredSheet;
  const sheets = await listWorksheets(base);
  const sourceSheetNames = new Set(["DP_LIVE", "KASALAR", "FORMUL", "BLOKELER", "SYSTEM"]);
  const preferred = sheets.find(sheet => !sourceSheetNames.has(sheet.name));
  return preferred?.name || sheets[0]?.name || "Sheet1";
}

function columnName(index) {
  let name = "";
  let n = index;
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name || "A";
}

function normalizeCell(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function normalizeValues(values) {
  const cols = Math.max(1, ...values.map(row => row.length));
  return values.map(row => Array.from({ length: cols }, (_, index) => normalizeCell(row[index])));
}

async function writeSheet(sheetName, values, clearAddress = "A1:Z2000") {
  if (!configured()) return { skipped: true, reason: "excel-disabled-or-missing-env" };
  const base = await workbookPath();
  await ensureWorksheet(base, sheetName);
  await graphFetch(`${rangePath(base, sheetName, clearAddress)}/clear`, {
    method: "POST",
    body: JSON.stringify({ applyTo: "Contents" })
  });
  if (!values.length) return { success: true };
  const normalized = normalizeValues(values);
  const address = `A1:${columnName(normalized[0].length)}${normalized.length}`;
  await graphFetch(rangePath(base, sheetName, address), {
    method: "PATCH",
    body: JSON.stringify({ values: normalized })
  });
  return { success: true };
}

async function patchRange(base, sheetName, address, values) {
  await graphFetch(rangePath(base, sheetName, address), {
    method: "PATCH",
    body: JSON.stringify({ values: normalizeValues(values) })
  });
}

function totalVault(state, key) {
  return Object.values(state?.vaults?.[key]?.sets || {})
    .flat()
    .reduce((sum, [, balance]) => {
      const amount = thousandFloor(balance);
      return sum + amount;
    }, 0);
}

function reconciliationByLabel(state) {
  return Object.fromEntries((state?.reconciliationRows || []).map(row => [String(row.label || "").trim(), row]));
}

function reconciliationValue(rows, label, field = "devir") {
  return numeric(rows[label]?.[field]);
}

function closureSummary(state, report = {}) {
  const rows = reconciliationByLabel(state);
  const vaultTotals = {
    atlas: totalVault(state, "atlas"),
    ecem: totalVault(state, "ecem"),
    aslan: totalVault(state, "aslan"),
    ares: totalVault(state, "ares")
  };
  const gelir = vaultTotals.atlas + vaultTotals.ecem + vaultTotals.aslan + vaultTotals.ares;
  const kasa = numeric(report.kasa ?? state?.latestReport?.kasa);
  const komisyon = numeric(report.komisyon ?? state?.latestReport?.komisyon);
  const gider = [
    "Personel Ödemesi",
    "Set Ödemesi Tutarı",
    "Bloke Tutarı",
    "Elif Abla Ödeme",
    "Cemal Abi Ödeme"
  ].reduce((sum, label) => sum + reconciliationValue(rows, label), 0);
  const dununBorcu = reconciliationValue(rows, "Dünün Borcu");
  const dununAlacagi = reconciliationValue(rows, "Dünün Alacağı");
  const borcKom = dununBorcu + dununAlacagi - komisyon;
  const kalmasiGereken = gider + borcKom;
  const kalan = kasa - gelir;
  return {
    vaultTotals,
    gelir,
    kasa,
    komisyon,
    gider,
    dununBorcu,
    dununAlacagi,
    borcKom,
    kalmasiGereken,
    kalan,
    fark: kalmasiGereken - kalan,
    rows
  };
}

async function writeKasaSection(state, report = {}) {
  if (!configured() || !kasaDirectEnabled()) return { skipped: true, reason: "kasa-direct-disabled" };
  const base = await workbookPath();
  const sheetName = await targetKasaSheetName(base);
  const summary = closureSummary(state, report);
  const rows = summary.rows;

  await patchRange(base, sheetName, "B38:D49", [
    [0, summary.kasa, 0],
    [0, 0, reconciliationValue(rows, "Personel Ödemesi")],
    [summary.vaultTotals.ares, 0, 0],
    [summary.vaultTotals.ecem, 0, 0],
    [summary.vaultTotals.aslan, 0, 0],
    [summary.vaultTotals.atlas, 0, 0],
    [0, 0, summary.komisyon],
    [0, 0, reconciliationValue(rows, "Set Ödemesi Tutarı")],
    [0, 0, reconciliationValue(rows, "Bloke Tutarı")],
    [0, 0, summary.dununBorcu],
    [0, 0, summary.dununAlacagi],
    [0, 0, reconciliationValue(rows, "Elif Abla Ödeme")],
    [0, 0, reconciliationValue(rows, "Cemal Abi Ödeme")]
  ]);
  await patchRange(base, sheetName, "A52:G52", [[
    summary.gelir,
    summary.kasa,
    summary.borcKom,
    summary.gider,
    summary.kalmasiGereken,
    summary.kalan,
    summary.fark
  ]]);
  return { success: true, sheetName };
}

async function writeLiveKasaCells(report = {}) {
  if (!configured() || !kasaDirectEnabled()) return { skipped: true, reason: "kasa-direct-disabled" };
  const base = await workbookPath();
  const sheetName = await targetKasaSheetName(base);
  await patchRange(base, sheetName, "C38", [[numeric(report.kasa)]]);
  await patchRange(base, sheetName, "D44", [[numeric(report.komisyon)]]);
  return { success: true, sheetName };
}

async function readSheet(sheetName) {
  if (!configured()) return [];
  const base = await workbookPath();
  try {
    await ensureWorksheet(base, sheetName);
    const range = await graphFetch(`${sheetPath(base, sheetName)}/usedRange(valuesOnly=true)`);
    return range?.values || [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

function rowsFromValues(values) {
  const headers = (values[0] || []).map(item => String(item || "").trim());
  return values.slice(1)
    .filter(row => row.some(cell => String(cell ?? "").trim() !== ""))
    .map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
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
    sourceTimestamp: payload?.timestamp || "",
    sourceUpdatedAt: selected.updatedAt || "",
    liveCapturedAt: payload?.bozokLive?.capturedAt || "",
    liveSeq: payload?.bozokLive?.seq || "",
    liveDeviceName: payload?.bozokLive?.deviceName || "",
    savedAt: new Date().toISOString()
  };
}

function reportValues(report) {
  const safeReport = report || {};
  return [
    [
      "departman", "tarih", "devir", "virman", "yatirim", "yatirim_kom",
      "cekim", "cekim_kom", "aktarim", "aktarim_kom", "takviye", "masraf",
      "teminat", "teminat_birimi", "kasa", "kaynak", "son_guncelleme"
    ],
    [
      safeReport.department || "",
      safeReport.date || "",
      numeric(safeReport.devir),
      numeric(safeReport.virman),
      numeric(safeReport.yatirim),
      numeric(safeReport.komisyon ?? safeReport.yatirim_kom),
      numeric(safeReport.cekim),
      numeric(safeReport.cekimKom),
      numeric(safeReport.aktarim),
      numeric(safeReport.aktarimKom),
      numeric(safeReport.takviye),
      numeric(safeReport.masraf),
      numeric(safeReport.teminat),
      safeReport.teminatBirimi || "",
      numeric(safeReport.kasa),
      safeReport.liveDeviceName || safeReport.source || "",
      safeReport.savedAt || safeReport.liveCapturedAt || new Date().toISOString()
    ]
  ];
}

function vaultRows(state) {
  const rows = [["kasa", "set", "banka", "bakiye", "bgColor", "title", "accent"]];
  for (const [vaultKey, vault] of Object.entries(state?.vaults || {})) {
    for (const [owner, accounts] of Object.entries(vault.sets || {})) {
      for (const account of accounts || []) {
        rows.push([
          vaultKey,
          owner,
          account[0] || "",
          numeric(account[1]),
          vault.bgColor || "",
          vault.title || "",
          vault.accent || ""
        ]);
      }
    }
  }
  return rows;
}

function reconciliationValues(state) {
  return [
    ["label", "group", "gelir", "kasa", "devir", "auto"],
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

function blockValues(state) {
  return [
    ["name", "amount", "note"],
    ...(state?.blockRows || []).map(row => [
      row.name || "",
      numeric(row.amount),
      row.note || ""
    ])
  ];
}

function systemValues(state, extra = {}) {
  const rows = [
    ["key", "value"],
    ["updatedAt", state?.updatedAt || ""],
    ["savedAt", state?.savedAt || ""],
    ["theme", state?.theme || ""],
    ["vaultStyle", state?.vaultStyle || ""],
    ["sectionVersions", JSON.stringify(state?.sectionVersions || {})],
    ["commissionHistory", JSON.stringify(state?.commissionHistory || [])],
    ["dayClosed", JSON.stringify(state?.dayClosed || null)],
    ["excelSavedAt", new Date().toISOString()]
  ];
  for (const [key, value] of Object.entries(extra)) rows.push([key, typeof value === "string" ? value : JSON.stringify(value)]);
  return rows;
}

async function syncDashboardStateNow(state) {
  if (!configured() || !state) return { skipped: true };
  await writeSheet("KASALAR", vaultRows(state));
  if (state.latestReport) await writeSheet("DP_LIVE", reportValues(state.latestReport));
  await writeSheet("FORMUL", reconciliationValues(state));
  await writeSheet("BLOKELER", blockValues(state));
  await writeSheet("SYSTEM", systemValues(state));
  await writeKasaSection(state, state.latestReport || {});
  excelRuntime.lastStateSyncAt = new Date().toISOString();
  excelRuntime.lastError = "";
  return { success: true };
}

async function syncMoonCacheNow(payload) {
  if (!configured() || !payload) return { skipped: true };
  const report = normalizeMoonReport(payload);
  if (!report) return { skipped: true, reason: "moon-report-empty" };
  await writeSheet("DP_LIVE", reportValues(report));
  if (kasaDirectEnabled()) {
    const currentState = await readDashboardStateFromExcel().catch(() => null);
    if (currentState) await writeKasaSection(currentState, report);
    else await writeLiveKasaCells(report);
  }
  excelRuntime.lastMoonSyncAt = new Date().toISOString();
  excelRuntime.lastError = "";
  return { success: true };
}

function schedule(kind, delay, runner) {
  const ref = kind === "state" ? stateTimer : moonTimer;
  if (ref) return;
  const timer = setTimeout(() => {
    if (kind === "state") stateTimer = null;
    else moonTimer = null;
    runner().catch(setExcelError);
  }, delay);
  if (kind === "state") stateTimer = timer;
  else moonTimer = timer;
}

async function flushStateSync() {
  if (stateSyncInFlight || !pendingState) return;
  stateSyncInFlight = true;
  const payload = pendingState;
  pendingState = null;
  try {
    await syncDashboardStateNow(payload);
  } finally {
    stateSyncInFlight = false;
    if (pendingState) schedule("state", syncMinMs(), flushStateSync);
  }
}

async function flushMoonSync() {
  if (moonSyncInFlight || !pendingMoon) return;
  moonSyncInFlight = true;
  const payload = pendingMoon;
  pendingMoon = null;
  try {
    await syncMoonCacheNow(payload);
  } finally {
    moonSyncInFlight = false;
    if (pendingMoon) schedule("moon", syncMinMs(), flushMoonSync);
  }
}

function syncDashboardStateToExcel(state, options = {}) {
  if (!configured()) return Promise.resolve({ skipped: true });
  if (options.force) return syncDashboardStateNow(state).catch(error => {
    setExcelError(error);
    throw error;
  });
  pendingState = state;
  const delay = Math.max(0, syncMinMs() - (Date.now() - timeMs(excelRuntime.lastStateSyncAt)));
  schedule("state", delay, flushStateSync);
  return Promise.resolve({ queued: true });
}

function syncMoonCacheToExcel(payload, options = {}) {
  if (!configured()) return Promise.resolve({ skipped: true });
  if (options.force) return syncMoonCacheNow(payload).catch(error => {
    setExcelError(error);
    throw error;
  });
  pendingMoon = payload;
  const delay = Math.max(0, syncMinMs() - (Date.now() - timeMs(excelRuntime.lastMoonSyncAt)));
  schedule("moon", delay, flushMoonSync);
  return Promise.resolve({ queued: true });
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function titleFromVaultKey(key) {
  const names = { atlas: "Atlas Bozok Kasa", ecem: "Ecem Bozok Kasa", aslan: "Aslan Bozok Kasa", ares: "Ares Bozok Kasa" };
  return names[key] || `${key} Kasa`;
}

function accentFromVaultKey(key) {
  const accents = { atlas: "green", ecem: "red", aslan: "blue", ares: "cyan" };
  return accents[key] || "blue";
}

async function readDashboardStateFromExcel() {
  if (!configured()) return null;
  const [vaultSheet, reportSheet, reconciliationSheet, blockSheet, systemSheet] = await Promise.all([
    readSheet("KASALAR"),
    readSheet("DP_LIVE"),
    readSheet("FORMUL"),
    readSheet("BLOKELER"),
    readSheet("SYSTEM")
  ]);
  const system = Object.fromEntries(rowsFromValues(systemSheet).map(row => [row.key, row.value]));
  const vaults = {};
  for (const row of rowsFromValues(vaultSheet)) {
    const vaultKey = String(row.kasa || "").trim();
    const owner = String(row.set || "").trim();
    const bank = String(row.banka || "").trim();
    if (!vaultKey || !owner || !bank) continue;
    vaults[vaultKey] ||= {
      title: row.title || titleFromVaultKey(vaultKey),
      accent: row.accent || accentFromVaultKey(vaultKey),
      sets: {}
    };
    if (row.bgColor) vaults[vaultKey].bgColor = row.bgColor;
    vaults[vaultKey].sets[owner] ||= [];
    vaults[vaultKey].sets[owner].push([bank, numeric(row.bakiye)]);
  }
  if (!Object.keys(vaults).length) return null;

  const reportRow = rowsFromValues(reportSheet).at(-1);
  const latestReport = reportRow ? {
    department: reportRow.departman || "",
    date: reportRow.tarih || "",
    devir: numeric(reportRow.devir),
    yatirim: numeric(reportRow.yatirim),
    cekim: numeric(reportRow.cekim),
    komisyon: numeric(reportRow.yatirim_kom || reportRow.komisyon),
    kasa: numeric(reportRow.kasa),
    liveDeviceName: reportRow.kaynak || "",
    savedAt: reportRow.son_guncelleme || new Date().toISOString()
  } : null;

  const reconciliationRows = rowsFromValues(reconciliationSheet).map(row => ({
    label: row.label || "",
    group: row.group || "",
    gelir: numeric(row.gelir),
    kasa: numeric(row.kasa),
    devir: numeric(row.devir),
    auto: parseJson(row.auto, undefined)
  })).filter(row => row.label);

  const blockRows = rowsFromValues(blockSheet).map(row => ({
    name: row.name || "",
    amount: numeric(row.amount),
    note: row.note || ""
  })).filter(row => row.name || row.amount);

  excelRuntime.lastReadAt = new Date().toISOString();
  excelRuntime.lastError = "";
  return {
    updatedAt: Number(system.updatedAt) || Date.now(),
    savedAt: system.savedAt || new Date().toISOString(),
    actor: "Excel",
    vaults,
    latestReport,
    reconciliationRows,
    blockRows,
    commissionHistory: parseJson(system.commissionHistory, []),
    dayClosed: parseJson(system.dayClosed, null),
    vaultStyle: system.vaultStyle || "",
    theme: system.theme || "",
    sectionVersions: parseJson(system.sectionVersions, {})
  };
}

module.exports = {
  excelCenterEnabled,
  excelPrimaryEnabled,
  excelStatus,
  syncDashboardStateToExcel,
  syncMoonCacheToExcel,
  readDashboardStateFromExcel
};
