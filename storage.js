const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const dashboardStatePath = path.join(root, "dashboard-state.json");
const historyPath = path.join(root, "change-history.json");
const closuresPath = path.join(root, "day-closures.json");

let pool = null;
let storageReady = false;

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
  const borcKom = dununBorcu + dununAlacagi - komisyon;
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
    latestReport: current.latestReport,
    reconciliationRows: current.reconciliationRows,
    blockRows: current.blockRows,
    commissionHistory: current.commissionHistory,
    dayClosed: current.dayClosed,
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
    ["dayClosed", "dayClosed"],
    ["vaultStyle", "vaultStyle"],
    ["theme", "theme"]
  ];

  for (const [section, field] of sections) {
    const incomingVersion = Number(incomingVersions[section] || 0);
    const currentVersion = Number(currentVersions[section] || 0);
    const effectiveIncoming = hasSectionVersions ? incomingVersion : incomingUpdatedAt;
    const effectiveCurrent = currentVersion || 0;
    const currentHasField = current && field in current && current[field] !== undefined;
    if (field in incoming && (effectiveIncoming > effectiveCurrent || !currentHasField)) {
      merged[field] = incoming[field];
      mergedVersions[section] = effectiveIncoming;
    }
  }

  return merged;
}

function stateClock(state, fallback = Date.now()) {
  const sectionMax = Math.max(0, ...Object.values(state?.sectionVersions || {}).map(Number).filter(Number.isFinite));
  return Math.max(Number(state?.updatedAt) || 0, sectionMax, fallback);
}

async function initStorage() {
  if (storageReady) return;
  if (!process.env.DATABASE_URL) {
    storageReady = true;
    return;
  }
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
  `);
  storageReady = true;
}

async function readMoonCache() {
  await initStorage();
  if (pool) {
    const result = await pool.query("select payload, updated_at as \"updatedAt\" from moon_cache where id = 1");
    const row = result.rows[0];
    return row ? { payload: row.payload, updatedAt: row.updatedAt } : null;
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
    const result = await pool.query(
      `insert into moon_cache (id, payload, updated_at)
       values (1, $1, now())
       on conflict (id) do update set payload = excluded.payload, updated_at = now()
       returning updated_at as "updatedAt"`,
      [JSON.stringify(payload)]
    );
    return { payload, updatedAt: result.rows[0]?.updatedAt || updatedAt, accepted: true, skipped: false };
  }
  return { payload, updatedAt, accepted: true, skipped: false };
}

async function readDashboardState() {
  await initStorage();
  if (pool) {
    const result = await pool.query("select state from dashboard_state where id = 1");
    return sanitizeState(result.rows[0]?.state || null);
  }
  return sanitizeState(fileJson(dashboardStatePath, null));
}

async function addHistory(changes, state, actor = "Panel") {
  if (!changes.length) return;
  await initStorage();
  const entry = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    actor,
    changes,
    stateUpdatedAt: state.updatedAt
  };
  if (pool) {
    await pool.query(
      "insert into change_history (actor, changes, state_updated_at) values ($1, $2, $3)",
      [actor, JSON.stringify(changes), state.updatedAt]
    );
    return;
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
  if (current && currentUpdatedAt > incomingUpdatedAt && !hasSectionVersions) return current;

  const incomingState = {
    ...sanitizeState(payload),
    updatedAt: incomingUpdatedAt,
    savedAt: new Date().toISOString()
  };
  const mergedState = mergeSectionedState(current, incomingState, incomingUpdatedAt);
  const state = sanitizeState({
    ...mergedState,
    updatedAt: stateClock(mergedState, Date.now()),
    savedAt: new Date().toISOString()
  });
  const changes = summarizeChanges(current, state);

  if (pool) {
    await pool.query(
      `insert into dashboard_state (id, state, updated_at, saved_at)
       values (1, $1, $2, now())
       on conflict (id) do update set state = excluded.state, updated_at = excluded.updated_at, saved_at = now()`,
      [JSON.stringify(state), state.updatedAt]
    );
  } else {
    writeJson(dashboardStatePath, state);
  }

  await addHistory(changes, state, payload.actor || "Panel");
  return state;
}

async function listHistory(limit = 50) {
  await initStorage();
  if (pool) {
    const result = await pool.query(
      "select id, created_at as \"createdAt\", actor, changes, state_updated_at as \"stateUpdatedAt\" from change_history order by id desc limit $1",
      [limit]
    );
    return result.rows;
  }
  return fileJson(historyPath, []).slice(0, limit);
}

async function closeDay(payload = {}) {
  await initStorage();
  const state = payload.state || await readDashboardState();
  if (!state) throw new Error("Kapatılacak dashboard kaydı yok.");
  const businessDate = payload.date || state.latestReport?.date || new Date().toISOString().slice(0, 10);
  const createdAt = new Date().toISOString();
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
    await pool.query("delete from day_closures where business_date = $1", [businessDate]);
    const result = await pool.query(
      "insert into day_closures (business_date, summary, state) values ($1, $2, $3) returning id, business_date as \"businessDate\", created_at as \"createdAt\", summary, state",
      [businessDate, JSON.stringify(closure.summary), JSON.stringify(closedState)]
    );
    await writeDashboardState({ ...closedState, actor: payload.actor || "Panel" });
    await addHistory([`${businessDate} gün sonu kapanışı alındı.`], closedState, payload.actor || "Panel");
    return result.rows[0];
  }

  const closures = fileJson(closuresPath, []);
  writeJson(closuresPath, [closure, ...closures.filter(item => item.businessDate !== businessDate)].slice(0, 100));
  writeJson(dashboardStatePath, closedState);
  await addHistory([`${businessDate} gün sonu kapanışı alındı.`], closedState, payload.actor || "Panel");
  return closure;
}

async function listClosures(limit = 30) {
  await initStorage();
  if (pool) {
    const result = await pool.query(
      "select id, business_date as \"businessDate\", created_at as \"createdAt\", summary from day_closures order by id desc limit $1",
      [limit]
    );
    return result.rows;
  }
  return fileJson(closuresPath, []).slice(0, limit).map(({ state, ...closure }) => closure);
}

module.exports = {
  initStorage,
  readMoonCache,
  writeMoonCache,
  readDashboardState,
  writeDashboardState,
  listHistory,
  closeDay,
  listClosures,
  closureSummary
};
