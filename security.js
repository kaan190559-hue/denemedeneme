const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { initStorage, queryDatabase, storageStatus } = require("./storage");

const root = process.env.BOZOK_DATA_DIR || __dirname;
const securityPath = path.join(root, "security-state.json");
const sessionCookieName = "bozok_session";
const lastSeenUpdates = new Map();

function securityEnabled() {
  return process.env.BOZOK_SECURITY_ENABLED === "1";
}

function safeText(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeUsername(value) {
  return safeText(value, 80).toLocaleLowerCase("tr-TR");
}

function readSecurityFile() {
  try {
    if (!fs.existsSync(securityPath)) {
      return { users: [], devices: [], sessions: [], events: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(securityPath, "utf8"));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    };
  } catch {
    return { users: [], devices: [], sessions: [], events: [] };
  }
}

function writeSecurityFile(state) {
  fs.writeFileSync(securityPath, JSON.stringify(state, null, 2));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  const value = String(secret || "");
  const key = crypto.scryptSync(value, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

function verifySecret(secret, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2], "hex");
  const actual = Buffer.from(hashSecret(secret, parts[1]).split("$")[2], "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role || "user",
    active: row.active !== false,
    createdAt: row.createdAt || row.created_at || "",
    updatedAt: row.updatedAt || row.updated_at || ""
  };
}

function publicDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId || row.user_id || "",
    username: row.username || "",
    label: row.label || "",
    fingerprint: row.fingerprint || {},
    active: row.active === true,
    createdAt: row.createdAt || row.created_at || "",
    lastSeenAt: row.lastSeenAt || row.last_seen_at || "",
    updatedAt: row.updatedAt || row.updated_at || ""
  };
}

function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    actorUserId: row.actorUserId || row.actor_user_id || "",
    userId: row.userId || row.user_id || "",
    deviceId: row.deviceId || row.device_id || "",
    message: row.message || "",
    meta: row.meta || {},
    createdAt: row.createdAt || row.created_at || ""
  };
}

async function eventLog(type, message, meta = {}) {
  const entry = {
    id: Date.now(),
    type,
    actorUserId: meta.actorUserId || "",
    userId: meta.userId || "",
    deviceId: meta.deviceId || "",
    message,
    meta,
    createdAt: new Date().toISOString()
  };
  await initStorage();
  const result = await queryDatabase(
    `insert into security_events (type, actor_user_id, user_id, device_id, message, meta)
     values ($1, $2, $3, $4, $5, $6)`,
    [entry.type, entry.actorUserId || null, entry.userId || null, entry.deviceId || null, entry.message, JSON.stringify(entry.meta || {})]
  );
  if (result) return entry;

  const state = readSecurityFile();
  state.events = [entry, ...state.events].slice(0, 300);
  writeSecurityFile(state);
  return entry;
}

async function countUsers() {
  await initStorage();
  const result = await queryDatabase("select count(*)::int as count from security_users");
  if (result) return Number(result.rows[0]?.count || 0);
  return readSecurityFile().users.length;
}

async function getUserByUsername(username) {
  const normalized = normalizeUsername(username);
  await initStorage();
  const result = await queryDatabase("select * from security_users where username = $1", [normalized]);
  if (result) return result.rows[0] || null;
  return readSecurityFile().users.find(user => user.username === normalized) || null;
}

async function getSession(sessionId) {
  await initStorage();
  const result = await queryDatabase(
    `select s.id, s.user_id as "userId", s.device_id as "deviceId", s.token_hash as "tokenHash",
            s.expires_at as "expiresAt", s.created_at as "createdAt", s.last_seen_at as "lastSeenAt",
            u.username, u.role, u.active as "userActive",
            d.label as "deviceLabel", d.active as "deviceActive"
       from security_sessions s
       join security_users u on u.id = s.user_id
       join security_devices d on d.id = s.device_id
      where s.id = $1`,
    [sessionId]
  );
  if (result) return result.rows[0] || null;

  const state = readSecurityFile();
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return null;
  const user = state.users.find(item => item.id === session.userId);
  const device = state.devices.find(item => item.id === session.deviceId);
  if (!user || !device) return null;
  return {
    ...session,
    username: user.username,
    role: user.role,
    userActive: user.active !== false,
    deviceLabel: device.label,
    deviceActive: device.active === true
  };
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((next, part) => {
    const index = part.indexOf("=");
    if (index === -1) return next;
    next[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    return next;
  }, {});
}

function sessionCookie(sessionId, token, expiresAt) {
  const maxAge = Math.max(60, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const secure = process.env.SECURITY_COOKIE_SECURE === "0" ? "" : (process.env.RENDER || process.env.SECURITY_COOKIE_SECURE === "1" ? "; Secure" : "");
  return `${sessionCookieName}=${encodeURIComponent(`${sessionId}.${token}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie() {
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function authenticateRequest(req) {
  if (!securityEnabled()) {
    return { enabled: false, authenticated: true, user: { username: "Panel", role: "system" }, device: null };
  }

  const raw = parseCookies(req)[sessionCookieName] || "";
  const [sessionId, token] = raw.split(".");
  if (!sessionId || !token) {
    return { enabled: true, authenticated: false, setupRequired: (await countUsers()) === 0 };
  }

  const session = await getSession(sessionId);
  if (!session || !verifySecret(token, session.tokenHash)) {
    return { enabled: true, authenticated: false, setupRequired: (await countUsers()) === 0 };
  }
  if (new Date(session.expiresAt).getTime() <= Date.now() || !session.userActive || !session.deviceActive) {
    return { enabled: true, authenticated: false, setupRequired: (await countUsers()) === 0 };
  }

  const now = Date.now();
  const lastSeenKey = `${sessionId}:${session.deviceId}`;
  if (now - Number(lastSeenUpdates.get(lastSeenKey) || 0) > 30000) {
    lastSeenUpdates.set(lastSeenKey, now);
    queryDatabase("update security_sessions set last_seen_at = now() where id = $1", [sessionId]).catch(() => {});
    queryDatabase("update security_devices set last_seen_at = now(), updated_at = now() where id = $1", [session.deviceId]).catch(() => {});
  }

  return {
    enabled: true,
    authenticated: true,
    user: {
      id: session.userId,
      username: session.username,
      role: session.role || "user",
      active: true
    },
    device: {
      id: session.deviceId,
      label: session.deviceLabel,
      active: true
    }
  };
}

function requireAdmin(context) {
  if (!context?.authenticated || context.user?.role !== "admin") {
    const error = new Error("Admin yetkisi gerekli.");
    error.status = 403;
    throw error;
  }
}

async function createUser({ username, password, role = "user", active = true }, actor = null) {
  const normalized = normalizeUsername(username);
  if (!normalized || String(password || "").length < 6) {
    throw new Error("Kullanıcı adı ve en az 6 karakter şifre gerekli.");
  }
  const user = {
    id: id("usr"),
    username: normalized,
    passwordHash: hashSecret(password),
    role: role === "admin" ? "admin" : "user",
    active: active !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await initStorage();
  const result = await queryDatabase(
    `insert into security_users (id, username, password_hash, role, active)
     values ($1, $2, $3, $4, $5)
     returning id, username, role, active, created_at as "createdAt", updated_at as "updatedAt"`,
    [user.id, user.username, user.passwordHash, user.role, user.active]
  );
  if (result) {
    await eventLog("user-created", `${user.username} kullanıcısı oluşturuldu.`, { actorUserId: actor?.user?.id || "", userId: user.id });
    return publicUser(result.rows[0]);
  }

  const state = readSecurityFile();
  if (state.users.some(item => item.username === user.username)) throw new Error("Bu kullanıcı zaten var.");
  state.users.push(user);
  writeSecurityFile(state);
  await eventLog("user-created", `${user.username} kullanıcısı oluşturuldu.`, { actorUserId: actor?.user?.id || "", userId: user.id });
  return publicUser(user);
}

async function setupFirstAdmin(payload = {}) {
  if ((await countUsers()) > 0) throw new Error("İlk admin zaten kurulu.");
  const setupCode = String(process.env.SECURITY_SETUP_CODE || "").trim();
  if (setupCode && String(payload.setupCode || "") !== setupCode) throw new Error("Kurulum kodu yanlış.");
  if (!setupCode && process.env.NODE_ENV === "production") throw new Error("SECURITY_SETUP_CODE env değeri gerekli.");
  const user = await createUser({ username: payload.username, password: payload.password, role: "admin" });
  await eventLog("security-setup", "İlk admin kurulumu tamamlandı.", { userId: user.id });
  return user;
}

async function login(payload = {}) {
  const username = normalizeUsername(payload.username);
  const user = await getUserByUsername(username);
  if (!user || user.active === false || !verifySecret(payload.password, user.password_hash || user.passwordHash)) {
    await eventLog("login-failed", `${username || "bilinmeyen"} için başarısız giriş.`, { username });
    throw new Error("Kullanıcı adı veya şifre hatalı.");
  }

  const deviceId = safeText(payload.deviceId, 80);
  const deviceSecret = String(payload.deviceSecret || "");
  const deviceLabel = safeText(payload.deviceLabel || "Tanımsız cihaz", 80);
  const fingerprint = payload.fingerprint && typeof payload.fingerprint === "object" ? payload.fingerprint : {};
  if (!deviceId || deviceSecret.length < 16) throw new Error("Cihaz kimliği eksik.");

  await initStorage();
  let device = null;
  const deviceResult = await queryDatabase(
    `select d.*, u.username from security_devices d join security_users u on u.id = d.user_id where d.id = $1 and d.user_id = $2`,
    [deviceId, user.id]
  );
  if (deviceResult) {
    device = deviceResult.rows[0] || null;
    if (device && !verifySecret(deviceSecret, device.device_hash)) device = null;
  }

  if (!deviceResult) {
    const state = readSecurityFile();
    device = state.devices.find(item => item.id === deviceId && item.userId === user.id && verifySecret(deviceSecret, item.deviceHash));
  }

  if (!device) {
    const pendingDevice = {
      id: deviceId,
      userId: user.id,
      username: user.username,
      label: deviceLabel,
      deviceHash: hashSecret(deviceSecret),
      fingerprint,
      active: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const upsert = await queryDatabase(
      `insert into security_devices (id, user_id, label, device_hash, fingerprint, active, updated_at)
       values ($1, $2, $3, $4, $5, false, now())
       on conflict (id) do update set
         user_id = excluded.user_id,
         label = excluded.label,
         device_hash = excluded.device_hash,
         fingerprint = excluded.fingerprint,
         active = false,
         updated_at = now()
       returning id, user_id as "userId", label, fingerprint, active, created_at as "createdAt", updated_at as "updatedAt"`,
      [pendingDevice.id, pendingDevice.userId, pendingDevice.label, pendingDevice.deviceHash, JSON.stringify(fingerprint)]
    );
    if (!upsert) {
      const state = readSecurityFile();
      state.devices = state.devices.filter(item => item.id !== pendingDevice.id);
      state.devices.push(pendingDevice);
      writeSecurityFile(state);
    }
    await eventLog("device-pending", `${user.username} için yeni cihaz onay bekliyor: ${deviceLabel}`, { userId: user.id, deviceId });
    return { status: "pending", user: publicUser(user), device: publicDevice(pendingDevice) };
  }

  if (device.active !== true) {
    await eventLog("device-waiting", `${user.username} cihaz onayı bekliyor: ${deviceLabel}`, { userId: user.id, deviceId });
    return { status: "pending", user: publicUser(user), device: publicDevice(device) };
  }

  const sessionId = id("ses");
  const token = crypto.randomBytes(32).toString("hex");
  const days = Math.max(1, Number(process.env.SECURITY_SESSION_DAYS || 14));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const session = {
    id: sessionId,
    userId: user.id,
    deviceId: device.id,
    tokenHash: hashSecret(token),
    expiresAt,
    createdAt: new Date().toISOString()
  };

  const sessionResult = await queryDatabase(
    `insert into security_sessions (id, user_id, device_id, token_hash, expires_at, last_seen_at)
     values ($1, $2, $3, $4, $5, now())`,
    [session.id, session.userId, session.deviceId, session.tokenHash, session.expiresAt]
  );
  if (!sessionResult) {
    const state = readSecurityFile();
    state.sessions.push(session);
    writeSecurityFile(state);
  }
  await eventLog("login-success", `${user.username} giriş yaptı.`, { userId: user.id, deviceId: device.id });
  return {
    status: "ok",
    cookie: sessionCookie(sessionId, token, expiresAt),
    user: publicUser(user),
    device: publicDevice(device)
  };
}

async function logout(context, cookieValue = "") {
  const [sessionId] = String(cookieValue || "").split(".");
  if (sessionId) {
    await initStorage();
    const result = await queryDatabase("delete from security_sessions where id = $1", [sessionId]);
    if (!result) {
      const state = readSecurityFile();
      state.sessions = state.sessions.filter(item => item.id !== sessionId);
      writeSecurityFile(state);
    }
  }
  if (context?.user?.id) {
    await eventLog("logout", `${context.user.username} çıkış yaptı.`, { userId: context.user.id, deviceId: context.device?.id || "" });
  }
}

async function securityOverview(context) {
  const setupRequired = (await countUsers()) === 0;
  if (!securityEnabled()) {
    return { enabled: false, setupRequired, users: [], devices: [], events: [], storage: storageStatus() };
  }
  if (!context?.authenticated) {
    return { enabled: true, authenticated: false, setupRequired, users: [], devices: [], events: [], storage: storageStatus() };
  }

  const admin = context.user?.role === "admin";
  await initStorage();
  const usersResult = admin ? await queryDatabase(
    `select id, username, role, active, created_at as "createdAt", updated_at as "updatedAt"
       from security_users order by username`
  ) : null;
  const devicesResult = await queryDatabase(
    `select d.id, d.user_id as "userId", u.username, d.label, d.fingerprint, d.active,
            d.created_at as "createdAt", d.last_seen_at as "lastSeenAt", d.updated_at as "updatedAt"
       from security_devices d
       join security_users u on u.id = d.user_id
      ${admin ? "" : "where d.user_id = $1"}
      order by d.updated_at desc`,
    admin ? [] : [context.user.id]
  );
  const eventsResult = admin ? await queryDatabase(
    `select id, type, actor_user_id as "actorUserId", user_id as "userId", device_id as "deviceId", message, meta, created_at as "createdAt"
       from security_events order by id desc limit 40`
  ) : null;

  if (devicesResult) {
    return {
      enabled: true,
      authenticated: true,
      setupRequired,
      user: context.user,
      device: context.device,
      users: admin ? (usersResult?.rows || []).map(publicUser) : [publicUser(context.user)],
      devices: devicesResult.rows.map(publicDevice),
      events: admin ? (eventsResult?.rows || []).map(publicEvent) : [],
      storage: storageStatus()
    };
  }

  const state = readSecurityFile();
  return {
    enabled: true,
    authenticated: true,
    setupRequired,
    user: context.user,
    device: context.device,
    users: admin ? state.users.map(publicUser) : [publicUser(context.user)],
    devices: state.devices
      .filter(item => admin || item.userId === context.user.id)
      .map(item => publicDevice({ ...item, user_id: item.userId })),
    events: admin ? state.events.slice(0, 40).map(publicEvent) : [],
    storage: storageStatus()
  };
}

async function createSecurityUser(context, payload) {
  requireAdmin(context);
  return createUser(payload, context);
}

async function updateSecurityUser(context, userId, payload = {}) {
  requireAdmin(context);
  if (userId === context.user.id && (payload.active === false || payload.role === "user")) {
    throw new Error("Kendi admin yetkini veya oturumunu buradan kapatamazsın.");
  }
  await initStorage();
  const fields = [];
  const values = [];
  if ("active" in payload) {
    values.push(Boolean(payload.active));
    fields.push(`active = $${values.length}`);
  }
  if (payload.role) {
    values.push(payload.role === "admin" ? "admin" : "user");
    fields.push(`role = $${values.length}`);
  }
  if (payload.password) {
    if (String(payload.password).length < 6) throw new Error("Şifre en az 6 karakter olmalı.");
    values.push(hashSecret(payload.password));
    fields.push(`password_hash = $${values.length}`);
  }
  if (!fields.length) throw new Error("Güncellenecek alan yok.");
  values.push(userId);
  const result = await queryDatabase(
    `update security_users set ${fields.join(", ")}, updated_at = now()
      where id = $${values.length}
      returning id, username, role, active, created_at as "createdAt", updated_at as "updatedAt"`,
    values
  );
  if (result) {
    if (payload.active === false) await queryDatabase("delete from security_sessions where user_id = $1", [userId]);
    await eventLog("user-updated", "Kullanıcı güncellendi.", { actorUserId: context.user.id, userId });
    return publicUser(result.rows[0]);
  }

  const state = readSecurityFile();
  const user = state.users.find(item => item.id === userId);
  if (!user) throw new Error("Kullanıcı bulunamadı.");
  if ("active" in payload) user.active = Boolean(payload.active);
  if (payload.role) user.role = payload.role === "admin" ? "admin" : "user";
  if (payload.password) user.passwordHash = hashSecret(payload.password);
  user.updatedAt = new Date().toISOString();
  if (payload.active === false) state.sessions = state.sessions.filter(item => item.userId !== userId);
  writeSecurityFile(state);
  await eventLog("user-updated", "Kullanıcı güncellendi.", { actorUserId: context.user.id, userId });
  return publicUser(user);
}

async function updateSecurityDevice(context, deviceId, payload = {}) {
  requireAdmin(context);
  const active = payload.action === "approve" || payload.active === true
    ? true
    : payload.action === "revoke" || payload.active === false
      ? false
      : null;
  if (active === null) throw new Error("Cihaz işlemi geçersiz.");
  await initStorage();
  const result = await queryDatabase(
    `update security_devices set active = $1, updated_at = now()
      where id = $2
      returning id, user_id as "userId", label, fingerprint, active, created_at as "createdAt", last_seen_at as "lastSeenAt", updated_at as "updatedAt"`,
    [active, deviceId]
  );
  if (result) {
    if (!active) await queryDatabase("delete from security_sessions where device_id = $1", [deviceId]);
    await eventLog(active ? "device-approved" : "device-revoked", active ? "Cihaz onaylandı." : "Cihaz iptal edildi.", { actorUserId: context.user.id, deviceId });
    return publicDevice(result.rows[0]);
  }

  const state = readSecurityFile();
  const device = state.devices.find(item => item.id === deviceId);
  if (!device) throw new Error("Cihaz bulunamadı.");
  device.active = active;
  device.updatedAt = new Date().toISOString();
  if (!active) state.sessions = state.sessions.filter(item => item.deviceId !== deviceId);
  writeSecurityFile(state);
  await eventLog(active ? "device-approved" : "device-revoked", active ? "Cihaz onaylandı." : "Cihaz iptal edildi.", { actorUserId: context.user.id, deviceId });
  return publicDevice(device);
}

module.exports = {
  securityEnabled,
  authenticateRequest,
  setupFirstAdmin,
  login,
  logout,
  clearSessionCookie,
  securityOverview,
  createSecurityUser,
  updateSecurityUser,
  updateSecurityDevice
};
