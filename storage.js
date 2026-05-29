const fs = require("node:fs");
const path = require("node:path");
const { defaultVaults } = require("./default-state");
const {
  syncDashboardStateToExcel,
  syncMoonCacheToExcel
} = require("./excel-center");
const {
  syncDashboardStateToOneDrive,
  syncMoonCacheToOneDrive,
  readMoonCacheFromOneDrive,
  centerPrimaryEnabled
} = require("./onedrive-center");

const root = __dirname;
const dashboardStatePath = path.join(root, "dashboard-state.json");
const historyPath = path.join(root, "change-history.json");
const closuresPath = path.join(root, "day-closures.json");
const moonCachePath = path.join(root, "moon-cache.json");
const moonSourcesPath = path.join(root, "moon-sources.json");
const telegramChatsPath = path.join(root, "telegram-chats.json");

let pool = null;
let storageReady = false;
let storageFallbackReason = "";
let databaseRetryAt = 0;
const databaseRetryDelayMs = Number(process.env.DATABASE_RETRY_DELAY_MS || 5000);

function disableDatabaseStorage(error) {
  storageFallbackReason = error?.message || String(error || "database-unavailable");
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
  storageReady = false;
  databaseRetryAt = Date.now() + databaseRetryDelayMs;
  console.error(`Database kullanilamiyor, dosya depoya geciliyor: ${storageFallbackReason}`);
}

function storageStatus() {
  return {
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    databaseActive: Boolean(pool),
    fallbackReason: storageFallbackReason,
    retryAt: databaseRetryAt ? new Date(databaseRetryAt).toISOString() : ""
  };
}

function fileJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

async function queryDatabase(sql, params = []) {
  if (!pool) return null;
  try {
    return await pool.query(sql, params);
  } catch (error) {
    disableDatabaseStorage(error);
    return null;
  }
}

function money(value) {
  return Math.floor(Number(value) || 0);
}

function normalizeOwnerName(owner) {
  const raw = String(owner || "");
  const compact = raw
    .replace(/\uFFFD/g, "")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.includes("ilan") && compact.includes("ak")) return "Şilan Akıcı";
  if (compact.includes("silca selcan")) return "Sıla Selcan";
  return raw;
}

function accountVersionPart(value) {
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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function accountVersionKeyFromParts(vaultKey, owner, bank, ordinal) {
  return [vaultKey, accountVersionPart(owner), accountVersionPart(bank), ordinal].join("|");
}

function accountMapFor(sourceVaults, vaultKey, owner) {
  const map = new Map();
  const accounts = sourceVaults?.[vaultKey]?.sets?.[owner] || [];
  const seen = {};
  accounts.forEach((account, index) => {
    const bankPart = accountVersionPart(account?.[0]);
    seen[bankPart] = (seen[bankPart] || 0) + 1;
    map.set(accountVersionKeyFromParts(vaultKey, owner, account?.[0], seen[bankPart]), index);
  });
  return map;
}

function mergeVersionMaps(current = {}, incoming = {}) {
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    merged[key] = Math.max(Number(merged[key] || 0), Number(value || 0));
  }
  return merged;
}

function applyAccountDeletions(sourceVaults, accountVersions = {}, deletions = {}) {
  for (const [vaultKey, vault] of Object.entries(sourceVaults || {})) {
    for (const [owner, accounts] of Object.entries(vault.sets || {})) {
      const seen = {};
      vault.sets[owner] = (accounts || []).filter(account => {
        const bankPart = accountVersionPart(account?.[0]);
        seen[bankPart] = (seen[bankPart] || 0) + 1;
        const key = accountVersionKeyFromParts(vaultKey, owner, account?.[0], seen[bankPart]);
        return Number(deletions[key] || 0) <= Number(accountVersions[key] || 0);
      });
    }
  }
  return sourceVaults;
}

function mergeVaultsByAccount(currentState = {}, incomingState = {}, incomingVaultVersion = 0) {
  const incomingAccountVersions = incomingState.accountVersions || {};
  const mergedAccountVersions = mergeVersionMaps(currentState.accountVersions, incomingState.accountVersions);
  const mergedDeletions = mergeVersionMaps(currentState.accountDeletions, incomingState.accountDeletions);
  if (!Object.keys(incomingAccountVersions).length) {
    const currentHasAccountVersions = Object.keys(currentState.accountVersions || {}).length > 0;
    const sourceVaults = currentHasAccountVersions ? currentState.vaults : incomingState.vaults;
    return applyAccountDeletions(sanitizeVaults(sourceVaults || {}), mergedAccountVersions, mergedDeletions);
  }

  const currentVaults = sanitizeVaults(currentState.vaults || {});
  const incomingVaults = sanitizeVaults(incomingState.vaults || {});
  const currentAccountVersions = currentState.accountVersions || {};
  const currentVaultVersion = Number(currentState.sectionVersions?.vaults || currentState.updatedAt || 0);

  for (const [vaultKey, incomingVault] of Object.entries(incomingVaults)) {
    currentVaults[vaultKey] ||= { ...incomingVault, sets: {} };
    currentVaults[vaultKey] = { ...currentVaults[vaultKey], ...incomingVault, sets: currentVaults[vaultKey].sets || {} };
    for (const [owner, incomingAccounts] of Object.entries(incomingVault.sets || {})) {
      if (!currentVaults[vaultKey].sets[owner]) {
        currentVaults[vaultKey].sets[owner] = JSON.parse(JSON.stringify(incomingAccounts || []));
        continue;
      }
      const currentAccounts = currentVaults[vaultKey].sets[owner];
      const currentMap = accountMapFor(currentVaults, vaultKey, owner);
      const incomingSeen = {};
      for (const incomingAccount of incomingAccounts || []) {
        const bankPart = accountVersionPart(incomingAccount?.[0]);
        incomingSeen[bankPart] = (incomingSeen[bankPart] || 0) + 1;
        const key = accountVersionKeyFromParts(vaultKey, owner, incomingAccount?.[0], incomingSeen[bankPart]);
        const incomingVersion = Number(incomingAccountVersions[key] || incomingVaultVersion || 0);
        const currentVersion = Number(currentAccountVersions[key] || currentVaultVersion || 0);
        const currentIndex = currentMap.get(key);
        if (currentIndex !== undefined) {
          if (incomingVersion > currentVersion) currentAccounts[currentIndex] = JSON.parse(JSON.stringify(incomingAccount));
        } else if (incomingVersion >= currentVaultVersion) {
          currentAccounts.push(JSON.parse(JSON.stringify(incomingAccount)));
        }
      }
    }
  }
  return applyAccountDeletions(currentVaults, mergedAccountVersions, mergedDeletions);
}

function sanitizeVaults(vaults = {}) {
  const nextVaults = JSON.parse(JSON.stringify(vaults || {}));
  for (const vault of Object.values(nextVaults)) {
    if (!vault?.sets) continue;
    for (const owner of Object.keys(vault.sets)) {
      const normalizedOwner = normalizeOwnerName(owner);
      if (normalizedOwner === owner) continue;
      vault.sets[normalizedOwner] = [...(vault.sets[normalizedOwner] || []), ...vault.sets[owner]];
      delete vault.sets[owner];
    }
  }
  return nextVaults;
}

function sanitizeState(state) {
  if (!state) return state;
  return {
    ...state,
    vaults: sanitizeVaults(state.vaults || {})
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((next, key) => {
      next[key] = canonicalValue(value[key]);
      return next;
    }, {});
  }
  return value;
}

const defaultVaultFingerprint = JSON.stringify(canonicalValue(sanitizeVaults(defaultVaults)));

function isDefaultVaultPayload(vaults) {
  return JSON.stringify(canonicalValue(sanitizeVaults(vaults || {}))) === defaultVaultFingerprint;
}

function totalVault(state, key) {
  return Object.values(state?.vaults?.[key]?.sets || {})
    .flat()
    .reduce((sum, [, balance]) => {
      const amount = money(balance);
      return sum + (amount >= 1000 ? Math.floor(amount / 1000) * 1000 : 0);
    }, 0);
}

function compactState(state) {
  if (!state) return null;
  return {
    vaults: state.vaults || {},
    accountVersions: state.accountVersions || {},
    accountDeletions: state.accountDeletions || {},
    latestReport: state.latestReport || null,
    reconciliationRows: state.reconciliationRows || [],
    blockRows: state.blockRows || [],
    commissionHistory: state.commissionHistory || [],
    dayClosed: state.dayClosed || null,
    vaultStyle: state.vaultStyle || "",
    theme: state.theme || ""
  };
}

function summarizeChanges(previous, next) {
  const before = compactState(previous);
  const after = compactState(next);
  if (!before) return ["İlk ortak kayıt oluşturuldu."];
  const changes = [];

  for (const key of ["atlas", "ecem", "aslan", "ares"]) {
    const oldTotal = totalVault(before, key);
    const newTotal = totalVault(after, key);
    if (oldTotal !== newTotal) changes.push(`${key.toUpperCase("tr-TR")} kasa ${oldTotal} -> ${newTotal}`);
  }

  const oldReport = before.latestReport || {};
  const newReport = after.latestReport || {};
  for (const key of ["kasa", "komisyon", "yatirim", "cekim"]) {
    if (money(oldReport[key]) !== money(newReport[key])) {
      changes.push(`Panel ${key} ${money(oldReport[key])} -> ${money(newReport[key])}`);
    }
  }

  const oldRows = Object.fromEntries((before.reconciliationRows || []).map(row => [row.label, row]));
  for (const row of after.reconciliationRows || []) {
    const oldRow = oldRows[row.label] || {};
    for (const field of ["gelir", "kasa", "devir"]) {
      if (String(oldRow[field] ?? "") !== String(row[field] ?? "")) {
        changes.push(`${row.label} ${field} ${oldRow[field] || 0} -> ${row[field] || 0}`);
      }
    }
  }

  if (JSON.stringify(before.blockRows || []) !== JSON.stringify(after.blockRows || [])) {
    changes.push("Bloke hesap tutarları güncellendi.");
  }
  if (JSON.stringify(before.dayClosed || null) !== JSON.stringify(after.dayClosed || null)) {
    changes.push(after.dayClosed ? `${after.dayClosed.businessDate || "Gün"} kapanış modu aktif.` : "Gün kapanış modu temizlendi.");
  }

  return changes.slice(0, 12);
}

function closureSummary(state) {
  const rows = state?.reconciliationRows || [];
  const value = (row, field) => money(row?.[field]);
  const gelir = totalVault(state, "atlas") + totalVault(state, "ecem") + totalVault(state, "aslan") + totalVault(state, "ares");
  const kasa = money(state?.latestReport?.kasa);
  const komisyon = money(state?.latestReport?.komisyon);
  const gider = rows
    .filter(row => row.group === "gider")
    .reduce((sum, row) => sum + value(row, "devir"), 0);
  const dununBorcu = rows
    .filter(row => row.group === "borcDusum")
    .reduce((sum, row) => sum + value(row, "devir"), 0);
  const dununAlacagi = rows
    .filter(row => row.group === "alacak")
    .reduce((sum, row) => sum + value(row, "devir"), 0);
  const borcKom = dununBorcu - komisyon - dununAlacagi;
  const kalmasiGereken = gider + borcKom;
  const kalan = kasa - gelir;
  return {
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
    vaultTotals: {
      atlas: totalVault(state, "atlas"),
      ecem: totalVault(state, "ecem"),
      aslan: totalVault(state, "aslan"),
      ares: totalVault(state, "ares")
    }
  };
}

function mergeSectionedState(current, incoming, incomingUpdatedAt) {
  if (!current) return incoming;
  const currentVersions = current.sectionVersions || {};
  const incomingVersions = incoming.sectionVersions || {};
  const hasSectionVersions = Boolean(incoming.sectionVersions);
  const mergedVersions = { ...currentVersions };
  const merged = {
    ...current,
    ...incoming,
    vaults: current.vaults,
    accountVersions: mergeVersionMaps(current.accountVersions, incoming.accountVersions),
    accountDeletions: mergeVersionMaps(current.accountDeletions, incoming.accountDeletions),
    latestReport: current.latestReport,
    reconciliationRows: current.reconciliationRows,
    blockRows: current.blockRows,
    commissionHistory: current.commissionHistory,
    chartHistory: current.chartHistory,
    dayClosed: current.dayClosed,
    setDetails: current.setDetails,
    vaultStyle: current.vaultStyle,
    theme: current.theme,
    sectionVersions: mergedVersions
  };

  const sections = [
    ["vaults", "vaults"],
    ["report", "latestReport"],
    ["reconciliation", "reconciliationRows"],
    ["blockRows", "blockRows"],
    ["commissionHistory", "commissionHistory"],
    ["chartHistory", "chartHistory"],
    ["dayClosed", "dayClosed"],
    ["setDetails", "setDetails"],
    ["vaultStyle", "vaultStyle"],
    ["theme", "theme"]
  ];

  for (const [section, field] of sections) {
    const incomingVersion = Number(incomingVersions[section] || 0);
    const currentVersion = Number(currentVersions[section] || 0);
    const effectiveIncoming = hasSectionVersions ? incomingVersion : incomingUpdatedAt;
    const effectiveCurrent = currentVersion || 0;
    const currentHasField = current && field in current && current[field] !== undefined;
    if (section === "vaults" && currentHasField && !isDefaultVaultPayload(current[field]) && isDefaultVaultPayload(incoming[field])) {
      continue;
    }
    if (field in incoming && (effectiveIncoming > effectiveCurrent || !currentHasField)) {
      merged[field] = section === "vaults"
        ? sanitizeVaults(incoming[field] || {})
        : incoming[field];
      mergedVersions[section] = effectiveIncoming;
    }
  }

  return merged;
}

function stateClock(state, fallback = Date.now()) {
  const sectionMax = Math.max(0, ...Object.values(state?.sectionVersions || {}).map(Number).filter(Number.isFinite));
  return Math.max(Number(state?.updatedAt) || 0, sectionMax, fallback);
}

function newestState(...states) {
  return states
    .filter(Boolean)
    .map(sanitizeState)
    .sort((a, b) => stateClock(b, 0) - stateClock(a, 0))[0] || null;
}

async function initStorage() {
  if (storageReady && pool) return;
  if (!process.env.DATABASE_URL) {
    storageReady = true;
    return;
  }
  if (databaseRetryAt && Date.now() < databaseRetryAt) return;
  try {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
    });
    await pool.query(`
      create table if not exists dashboard_state (
        id integer primary key default 1,
        state jsonb not null,
        updated_at bigint not null,
        saved_at timestamptz not null default now(),
        constraint dashboard_state_singleton check (id = 1)
      );
      create table if not exists change_history (
        id bigserial primary key,
        created_at timestamptz not null default now(),
        actor text not null default 'Panel',
        changes jsonb not null,
        state_updated_at bigint not null
      );
      create table if not exists day_closures (
        id bigserial primary key,
        business_date text not null,
        created_at timestamptz not null default now(),
        summary jsonb not null,
        state jsonb not null
      );
      create table if not exists moon_cache (
        id integer primary key default 1,
        payload jsonb not null,
        updated_at timestamptz not null default now(),
        constraint moon_cache_singleton check (id = 1)
      );
      create table if not exists moon_sources (
        device_name text primary key,
        payload jsonb not null,
        captured_at timestamptz,
        seq bigint not null default 0,
        accepted boolean not null default false,
        updated_at timestamptz not null default now()
      );
      create table if not exists telegram_chats (
        chat_id text primary key,
        title text,
        type text,
        daily_enabled boolean not null default true,
        updated_at timestamptz not null default now()
      );
      alter table change_history add column if not exists state jsonb;
    `);
    storageReady = true;
    storageFallbackReason = "";
    databaseRetryAt = 0;
  } catch (error) {
    disableDatabaseStorage(error);
  }
}

async function rememberTelegramChat(chat = {}) {
  await initStorage();
  const chatId = String(chat.id || "").trim();
  if (!chatId) return null;
  const title = String(chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "").slice(0, 120);
  const type = String(chat.type || "").slice(0, 40);
  const entry = { chatId, title, type, dailyEnabled: true, updatedAt: new Date().toISOString() };

  if (pool) {
    const result = await queryDatabase(
      `insert into telegram_chats (chat_id, title, type, daily_enabled, updated_at)
       values ($1, $2, $3, true, now())
       on conflict (chat_id) do update set
         title = excluded.title,
         type = excluded.type,
         updated_at = now()
       returning chat_id as "chatId", title, type, daily_enabled as "dailyEnabled", updated_at as "updatedAt"`,
      [chatId, title, type]
    );
    if (result) return result.rows[0] || entry;
  }

  const chats = fileJson(telegramChatsPath, {});
  chats[chatId] = { ...(chats[chatId] || {}), ...entry, dailyEnabled: chats[chatId]?.dailyEnabled ?? true };
  writeJson(telegramChatsPath, chats);
  return chats[chatId];
}

async function setTelegramDailyEnabled(chatId, enabled) {
  await initStorage();
  const id = String(chatId || "").trim();
  if (!id) return null;

  if (pool) {
    const result = await queryDatabase(
      `insert into telegram_chats (chat_id, daily_enabled, updated_at)
       values ($1, $2, now())
       on conflict (chat_id) do update set daily_enabled = excluded.daily_enabled, updated_at = now()
       returning chat_id as "chatId", title, type, daily_enabled as "dailyEnabled", updated_at as "updatedAt"`,
      [id, Boolean(enabled)]
    );
    if (result) return result.rows[0] || null;
  }

  const chats = fileJson(telegramChatsPath, {});
  chats[id] = { ...(chats[id] || { chatId: id }), dailyEnabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  writeJson(telegramChatsPath, chats);
  return chats[id];
}

async function listTelegramDailyChats() {
  await initStorage();
  const normalize = item => ({
    chatId: String(item.chatId || item.chat_id || ""),
    title: item.title || "",
    type: item.type || "",
    dailyEnabled: item.dailyEnabled ?? item.daily_enabled ?? true,
    updatedAt: item.updatedAt || item.updated_at || ""
  });

  if (pool) {
    const result = await queryDatabase(
      `select chat_id as "chatId", title, type, daily_enabled as "dailyEnabled", updated_at as "updatedAt"
       from telegram_chats
       where daily_enabled = true
       order by updated_at desc`
    );
    if (result) return result.rows.map(normalize).filter(item => item.chatId);
  }

  return Object.values(fileJson(telegramChatsPath, {}))
    .map(normalize)
    .filter(item => item.chatId && item.dailyEnabled !== false);
}

function moonSourceDeviceName(payload) {
  return String(payload?.bozokLive?.deviceName || "Bilinmeyen cihaz").trim().slice(0, 80) || "Bilinmeyen cihaz";
}

async function writeMoonSource(payload, accepted = false) {
  await initStorage();
  const deviceName = moonSourceDeviceName(payload);
  const capturedAt = payload?.bozokLive?.capturedAt || null;
  const seq = Number(payload?.bozokLive?.seq || 0);
  const entry = {
    deviceName,
    payload,
    capturedAt,
    seq,
    accepted: Boolean(accepted),
    updatedAt: new Date().toISOString()
  };

  if (pool) {
    const result = await queryDatabase(
      `insert into moon_sources (device_name, payload, captured_at, seq, accepted, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (device_name) do update set
         payload = excluded.payload,
         captured_at = excluded.captured_at,
         seq = excluded.seq,
         accepted = excluded.accepted,
         updated_at = now()
       returning device_name as "deviceName", captured_at as "capturedAt", seq, accepted, updated_at as "updatedAt"`,
      [deviceName, JSON.stringify(payload), capturedAt, seq, Boolean(accepted)]
    );
    if (result) return result.rows[0] || entry;
  }

  const sources = fileJson(moonSourcesPath, {});
  sources[deviceName] = entry;
  writeJson(moonSourcesPath, sources);
  return entry;
}

async function listMoonSources(activeMs = 60000) {
  await initStorage();
  const cutoff = Date.now() - Number(activeMs || 60000);
  const normalize = item => {
    const updatedAt = item.updatedAt || item.updated_at || "";
    const capturedAt = item.capturedAt || item.captured_at || "";
    return {
      deviceName: item.deviceName || item.device_name || "Bilinmeyen cihaz",
      updatedAt,
      capturedAt,
      seq: Number(item.seq || 0),
      accepted: Boolean(item.accepted),
      ageMs: updatedAt ? Date.now() - new Date(updatedAt).getTime() : null
    };
  };

  if (pool) {
    const result = await queryDatabase(
      `select device_name as "deviceName", captured_at as "capturedAt", seq, accepted, updated_at as "updatedAt"
       from moon_sources
       where updated_at >= to_timestamp($1 / 1000.0)
       order by updated_at desc`,
      [cutoff]
    );
    if (result) return result.rows.map(normalize);
  }

  return Object.values(fileJson(moonSourcesPath, {}))
    .map(normalize)
    .filter(item => !item.ageMs || item.ageMs <= activeMs)
    .sort((a, b) => Number(a.ageMs || 0) - Number(b.ageMs || 0));
}

async function readMoonCache() {
  await initStorage();
  const candidates = [];
  if (pool) {
    const result = await queryDatabase("select payload, updated_at as \"updatedAt\" from moon_cache where id = 1");
    if (result) {
      const row = result.rows[0];
      if (row) candidates.push({ payload: row.payload, updatedAt: row.updatedAt });
    }
  }
  candidates.push(fileJson(moonCachePath, null));
  const current = candidates
    .filter(record => record?.payload)
    .sort((a, b) => Math.max(recordUpdatedAtMs(b), moonPayloadClock(b.payload)) - Math.max(recordUpdatedAtMs(a), moonPayloadClock(a.payload)))[0];
  if (current) return current;
  if (centerPrimaryEnabled()) {
    try {
      return readMoonCacheFromOneDrive();
    } catch (error) {
      console.error(`OneDrive moon cache okunamadi, mevcut kayda dusuluyor: ${error.message}`);
    }
  }
  return null;
}

function moonPayloadClock(payload) {
  const seq = Number(payload?.bozokLive?.seq || 0);
  const capturedAt = Date.parse(payload?.bozokLive?.capturedAt || "") || 0;
  const sourceTimestamp = Number(payload?.timestamp || 0);
  return Math.max(seq, capturedAt, sourceTimestamp);
}

function recordUpdatedAtMs(record) {
  const time = new Date(record?.updatedAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldKeepCurrentMoonRecord(current, incoming) {
  if (!current?.payload) return false;
  const currentClock = moonPayloadClock(current.payload);
  const incomingClock = moonPayloadClock(incoming);
  const currentAgeMs = Date.now() - recordUpdatedAtMs(current);
  const currentIsFresh = currentAgeMs >= 0 && currentAgeMs < 15000;
  return currentClock > incomingClock && currentIsFresh;
}

async function writeMoonCache(payload) {
  await initStorage();
  const current = await readMoonCache();
  if (shouldKeepCurrentMoonRecord(current, payload)) {
    await writeMoonSource(payload, false);
    return {
      payload: current.payload,
      updatedAt: current.updatedAt,
      accepted: false,
      skipped: true,
      reason: "current-cache-is-newer",
      currentDeviceName: current.payload?.bozokLive?.deviceName || "",
      incomingDeviceName: payload?.bozokLive?.deviceName || ""
    };
  }
  const updatedAt = new Date().toISOString();
  if (pool) {
    const result = await queryDatabase(
      `insert into moon_cache (id, payload, updated_at)
       values (1, $1, now())
       on conflict (id) do update set payload = excluded.payload, updated_at = now()
       returning updated_at as "updatedAt"`,
      [JSON.stringify(payload)]
    );
    if (result) {
      const savedAt = result.rows[0]?.updatedAt || updatedAt;
      writeJson(moonCachePath, { payload, updatedAt: savedAt });
      await writeMoonSource(payload, true);
      syncMoonCacheToExcel(payload).catch(error => console.error(`Excel moon sync hatasi: ${error.message}`));
      syncMoonCacheToOneDrive(payload).catch(error => console.error(`OneDrive moon sync hatasi: ${error.message}`));
      return { payload, updatedAt: savedAt, accepted: true, skipped: false };
    }
  }
  writeJson(moonCachePath, { payload, updatedAt });
  await writeMoonSource(payload, true);
  syncMoonCacheToExcel(payload).catch(error => console.error(`Excel moon sync hatasi: ${error.message}`));
  syncMoonCacheToOneDrive(payload).catch(error => console.error(`OneDrive moon sync hatasi: ${error.message}`));
  return { payload, updatedAt, accepted: true, skipped: false };
}

async function readDashboardState() {
  await initStorage();
  const candidates = [];

  if (pool) {
    const result = await queryDatabase("select state from dashboard_state where id = 1");
    if (result) candidates.push(result.rows[0]?.state || null);
  }

  candidates.push(fileJson(dashboardStatePath, null));

  return newestState(...candidates);
}

async function addHistory(changes, state, actor = "Panel") {
  if (!changes.length) return;
  await initStorage();
  const entry = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    actor,
    changes,
    stateUpdatedAt: state.updatedAt,
    state
  };
  if (pool) {
    const result = await queryDatabase(
      "insert into change_history (actor, changes, state_updated_at, state) values ($1, $2, $3, $4)",
      [actor, JSON.stringify(changes), state.updatedAt, JSON.stringify(state)]
    );
    if (result) return;
  }
  const history = fileJson(historyPath, []);
  writeJson(historyPath, [entry, ...history].slice(0, 200));
}

async function writeDashboardState(payload) {
  await initStorage();
  const current = sanitizeState(await readDashboardState());
  const incomingUpdatedAt = Number(payload.updatedAt) || Date.now();
  const currentUpdatedAt = Number(current?.updatedAt) || 0;
  const hasSectionVersions = Boolean(payload.sectionVersions);
  const forceReplace = payload.forceReplace === true;
  if (!forceReplace && current && currentUpdatedAt > incomingUpdatedAt && !hasSectionVersions) return current;

  const incomingState = {
    ...sanitizeState(payload),
    updatedAt: incomingUpdatedAt,
    savedAt: new Date().toISOString()
  };
  const mergedState = forceReplace ? incomingState : mergeSectionedState(current, incomingState, incomingUpdatedAt);
  const state = sanitizeState({
    ...mergedState,
    updatedAt: stateClock(mergedState, Date.now()),
    savedAt: new Date().toISOString()
  });
  const changes = summarizeChanges(current, state);

  if (pool) {
    const result = await queryDatabase(
      `insert into dashboard_state (id, state, updated_at, saved_at)
       values (1, $1, $2, now())
       on conflict (id) do update set state = excluded.state, updated_at = excluded.updated_at, saved_at = now()`,
      [JSON.stringify(state), state.updatedAt]
    );
  }
  writeJson(dashboardStatePath, state);

  await addHistory(changes, state, payload.actor || "Panel");
  syncDashboardStateToExcel(state).catch(error => console.error(`Excel dashboard sync hatasi: ${error.message}`));
  syncDashboardStateToOneDrive(state).catch(error => console.error(`OneDrive dashboard sync hatasi: ${error.message}`));
  return state;
}

async function listHistory(limit = 50, includeState = false) {
  await initStorage();
  if (pool) {
    const result = await queryDatabase(
      `select id, created_at as "createdAt", actor, changes, state_updated_at as "stateUpdatedAt"${includeState ? ", state" : ""}
       from change_history order by id desc limit $1`,
      [limit]
    );
    if (result) return result.rows;
  }
  return fileJson(historyPath, []).slice(0, limit).map(entry => includeState ? entry : {
    id: entry.id,
    createdAt: entry.createdAt,
    actor: entry.actor,
    changes: entry.changes,
    stateUpdatedAt: entry.stateUpdatedAt
  });
}

async function closeDay(payload = {}) {
  await initStorage();
  const state = payload.state || await readDashboardState();
  if (!state) throw new Error("Kapatılacak dashboard kaydı yok.");
  const businessDate = payload.date || state.latestReport?.date || new Date().toISOString().slice(0, 10);
  const createdAt = new Date().toISOString();
  const archiveOnly = payload.archiveOnly === true;
  const summary = closureSummary(state);
  const closedState = sanitizeState({
    ...state,
    updatedAt: Date.now(),
    dayClosed: {
      businessDate,
      createdAt,
      summary
    },
    sectionVersions: {
      ...(state.sectionVersions || {}),
      dayClosed: Date.now()
    }
  });
  const closure = {
    id: Date.now(),
    businessDate,
    createdAt,
    summary,
    state: closedState
  };

  if (pool) {
    await queryDatabase("delete from day_closures where business_date = $1", [businessDate]);
    const result = await queryDatabase(
      "insert into day_closures (business_date, summary, state) values ($1, $2, $3) returning id, business_date as \"businessDate\", created_at as \"createdAt\", summary, state",
      [businessDate, JSON.stringify(closure.summary), JSON.stringify(closedState)]
    );
    if (result) {
      if (!archiveOnly) {
        await writeDashboardState({ ...closedState, actor: payload.actor || "Panel" });
      }
      await addHistory([`${businessDate} gün sonu kapanışı alındı.`], closedState, payload.actor || "Panel");
      return result.rows[0];
    }
  }

  const closures = fileJson(closuresPath, []);
  writeJson(closuresPath, [closure, ...closures.filter(item => item.businessDate !== businessDate)].slice(0, 100));
  if (!archiveOnly) {
    writeJson(dashboardStatePath, closedState);
  }
  await addHistory([`${businessDate} gün sonu kapanışı alındı.`], closedState, payload.actor || "Panel");
  return closure;
}

async function listClosures(limit = 30) {
  await initStorage();
  if (pool) {
    const result = await queryDatabase(
      "select id, business_date as \"businessDate\", created_at as \"createdAt\", summary from day_closures order by id desc limit $1",
      [limit]
    );
    if (result) return result.rows;
  }
  return fileJson(closuresPath, []).slice(0, limit).map(({ state, ...closure }) => closure);
}

module.exports = {
  initStorage,
  readMoonCache,
  writeMoonCache,
  listMoonSources,
  rememberTelegramChat,
  setTelegramDailyEnabled,
  listTelegramDailyChats,
  readDashboardState,
  writeDashboardState,
  listHistory,
  closeDay,
  listClosures,
  closureSummary,
  storageStatus
};
