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
  `);
  storageReady = true;
}

async function readDashboardState() {
  await initStorage();
  if (pool) {
    const result = await pool.query("select state from dashboard_state where id = 1");
    return result.rows[0]?.state || null;
  }
  return fileJson(dashboardStatePath, null);
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
  const current = await readDashboardState();
  const incomingUpdatedAt = Number(payload.updatedAt) || Date.now();
  const currentUpdatedAt = Number(current?.updatedAt) || 0;
  if (current && currentUpdatedAt > incomingUpdatedAt) return current;

  const state = {
    ...payload,
    updatedAt: incomingUpdatedAt,
    savedAt: new Date().toISOString()
  };
  const changes = summarizeChanges(current, state);

  if (pool) {
    await pool.query(
      `insert into dashboard_state (id, state, updated_at, saved_at)
       values (1, $1, $2, now())
       on conflict (id) do update set state = excluded.state, updated_at = excluded.updated_at, saved_at = now()`,
      [JSON.stringify(state), incomingUpdatedAt]
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
  const closure = {
    id: Date.now(),
    businessDate,
    createdAt: new Date().toISOString(),
    summary: closureSummary(state),
    state
  };

  if (pool) {
    const result = await pool.query(
      "insert into day_closures (business_date, summary, state) values ($1, $2, $3) returning id, business_date as \"businessDate\", created_at as \"createdAt\", summary, state",
      [businessDate, JSON.stringify(closure.summary), JSON.stringify(state)]
    );
    await addHistory([`${businessDate} gün sonu kapanışı alındı.`], state, payload.actor || "Panel");
    return result.rows[0];
  }

  const closures = fileJson(closuresPath, []);
  writeJson(closuresPath, [closure, ...closures].slice(0, 100));
  await addHistory([`${businessDate} gün sonu kapanışı alındı.`], state, payload.actor || "Panel");
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
  readDashboardState,
  writeDashboardState,
  listHistory,
  closeDay,
  listClosures,
  closureSummary
};
