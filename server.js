const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// configurable via env
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEVS_FILE    = path.join(DATA_DIR, 'devs.json');
const USERS_FILE   = path.join(DATA_DIR, 'users.json');
const KEYS_FILE    = path.join(DATA_DIR, 'keys.json');
const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
const LOGS_FILE    = path.join(DATA_DIR, 'logs.json');
const SECRET_FILE  = path.join(DATA_DIR, '.session-secret');

// configurable: max execution log entries kept on disk
const LOG_MAX = 2000;

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
  // first-install seed: write a default dev account only if devs.json doesn't exist.
  // remove a seeded dev account by editing devs.json directly; restart won't recreate it.
  // configurable: change SEED_DEV_USERNAME / SEED_DEV_PASSWORD env vars to override the default.
  if (!fs.existsSync(DEVS_FILE)) {
    const u = process.env.SEED_DEV_USERNAME || 'bruvo';
    const p = process.env.SEED_DEV_PASSWORD || 'Bruvofr@2011';
    writeJson(DEVS_FILE, [{
      username: u,
      passwordHash: bcrypt.hashSync(p, 10),
      createdAt: new Date().toISOString()
    }]);
  }
  if (!fs.existsSync(USERS_FILE))   writeJson(USERS_FILE, []);
  if (!fs.existsSync(KEYS_FILE))    writeJson(KEYS_FILE, []);
  if (!fs.existsSync(SCRIPTS_FILE)) writeJson(SCRIPTS_FILE, []);
  if (!fs.existsSync(LOGS_FILE))    writeJson(LOGS_FILE, []);
}
seed();

if (PROD) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '));
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// configurable: request body size caps
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: true, limit: '32kb' }));

app.use(session({
  name: 'skl.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // configurable: session lifetime (30 days)
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD
  }
}));

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

// configurable: rate limits
const loginLimiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: 'too many sign-in attempts. try again in a few minutes.' });
const signupLimiter    = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: 'too many account attempts. try again later.' });
const heartbeatLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: 'too many heartbeats' });
const checkLimiter     = rateLimit({ windowMs: 60 * 1000, max: 240, message: 'too many checks' });
const logLimiter       = rateLimit({ windowMs: 60 * 1000, max: 240, message: 'too many log writes' });
const likeLimiter      = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'slow down on the likes' });

// configurable: how long a game stays "active" after last heartbeat (ms)
const HEARTBEAT_TTL = 30 * 1000;
// configurable: how long after sign-in/activity a user counts as "online" for in-game GUI access (ms)
const ACTIVITY_WINDOW = 24 * 60 * 60 * 1000;

const activeGames = new Map();
const userActivity = new Map();

function touchActivity(username) {
  if (username) userActivity.set(username, Date.now());
}

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

function genKey() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `SKL-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20,24)}`;
}
function userStillExists(session) {
  if (!session || !session.user) return false;
  const { username, kind } = session.user;
  const file = kind === 'dev' ? DEVS_FILE : USERS_FILE;
  const all = readJson(file, []);
  return !!all.find(u => u.username === username);
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

app.post('/api/auth/signup', signupLimiter, (req, res) => {
  const { key, username, password } = req.body || {};
  if (typeof key !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'all fields are required' });
  }
  if (!key || !username || !password) return res.status(400).json({ error: 'all fields are required' });
  if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'username must be 3–24 characters' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'username: letters, numbers, _ or - only' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'password must be 8–128 characters' });

  const keys = readJson(KEYS_FILE, []);
  const k = keys.find(x => x.key === key.trim());
  if (!k)                                                  return res.status(404).json({ error: 'invalid key' });
  if (k.consumed)                                          return res.status(403).json({ error: 'this key has already been used' });
  if (k.revoked)                                           return res.status(403).json({ error: 'this key has been revoked' });
  if (k.expiresAt && new Date(k.expiresAt) < new Date())   return res.status(403).json({ error: 'this key has expired' });

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
    res.json({ ok: true, user: req.session.user });
  });
});

function ensureGameToken(record, file, all) {
  if (!record.gameToken) {
    record.gameToken = crypto.randomBytes(18).toString('hex');
    writeJson(file, all);
  }
  return record.gameToken;
}

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
    return res.status(401).json({ error: 'wrong username or password' });
  }
  ensureGameToken(user, bucketFile, bucketAll);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.user = { username: user.username, kind };
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('skl.sid');
    res.json({ ok: true });
  });
});

app.get('/api/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get('/api/keys', requireDev, (req, res) => {
  res.json({ keys: readJson(KEYS_FILE, []) });
});

app.post('/api/keys', requireDev, (req, res) => {
  const { count = 1, durationHours = 0, note = '' } = req.body || {};
  const keys = readJson(KEYS_FILE, []);
  const minted = [];
  // configurable: max keys minted per request
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
  const dh = Math.max(parseInt(durationHours, 10) || 0, 0);
  const safeNote = String(note || '').slice(0, 120);
  for (let i = 0; i < n; i++) {
    const k = {
      key: genKey(),
      createdBy: req.session.user.username,
      createdAt: new Date().toISOString(),
      expiresAt: dh > 0 ? new Date(Date.now() + dh * 3600 * 1000).toISOString() : null,
      consumed: false,
      revoked: false,
      note: safeNote
    };
    keys.push(k);
    minted.push(k);
  }
  writeJson(KEYS_FILE, keys);
  res.json({ ok: true, minted });
});

function purgeUserByKey(key) {
  const users = readJson(USERS_FILE, []);
  const removed = users.filter(u => u.keyUsed === key);
  if (!removed.length) return [];
  writeJson(USERS_FILE, users.filter(u => u.keyUsed !== key));
  for (const u of removed) userActivity.delete(u.username);
  return removed.map(u => u.username);
}

app.post('/api/keys/:key/revoke', requireDev, (req, res) => {
  const keys = readJson(KEYS_FILE, []);
  const e = keys.find(k => k.key === req.params.key);
  if (!e) return res.status(404).json({ error: 'not found' });
  e.revoked = true;
  writeJson(KEYS_FILE, keys);
  const removedUsers = purgeUserByKey(req.params.key);
  res.json({ ok: true, removedUsers });
});

app.delete('/api/keys/:key', requireDev, (req, res) => {
  let keys = readJson(KEYS_FILE, []);
  keys = keys.filter(k => k.key !== req.params.key);
  writeJson(KEYS_FILE, keys);
  const removedUsers = purgeUserByKey(req.params.key);
  res.json({ ok: true, removedUsers });
});

// configurable: valid script categories
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
  // configurable: max script body size
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

app.post('/api/scripts', requireDev, (req, res) => {
  const { title, tags = [], body, category } = req.body || {};
  const r = buildScript({ title, body, tags, category, author: req.session.user.username });
  if (r.error) return res.status(r.error.includes('too large') ? 413 : 400).json({ error: r.error });
  const scripts = readJson(SCRIPTS_FILE, []);
  scripts.unshift(r.script);
  writeJson(SCRIPTS_FILE, scripts);
  res.json({ ok: true, script: r.script });
});

// configurable: max items per bulk import call
const IMPORT_MAX = 500;
app.post('/api/scripts/import', requireDev, (req, res) => {
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
  res.json({ ok: true, imported: imported.length, skipped: skipped.length, skippedDetail: skipped.slice(0, 20) });
});

app.delete('/api/scripts/:id', requireDev, (req, res) => {
  let scripts = readJson(SCRIPTS_FILE, []);
  const t = scripts.find(s => s.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.author !== req.session.user.username) return res.status(403).json({ error: 'only the author can remove this' });
  scripts = scripts.filter(s => s.id !== req.params.id);
  writeJson(SCRIPTS_FILE, scripts);
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

app.get('/api/games', requireUser, (req, res) => {
  const cutoff = Date.now() - HEARTBEAT_TTL;
  const me = req.session.user.username;
  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let rec = devs.find(d => d.username === me) || users.find(u => u.username === me);
  let token = '';
  if (rec) {
    const file = devs.includes(rec) ? DEVS_FILE : USERS_FILE;
    const all  = devs.includes(rec) ? devs : users;
    token = ensureGameToken(rec, file, all);
  }

  const live = [...activeGames.values()].filter(g => g.lastSeen >= cutoff);
  const byPlace = new Map();
  for (const g of live) {
    if (!byPlace.has(g.placeId)) {
      byPlace.set(g.placeId, {
        placeId: g.placeId,
        name: g.name,
        thumbnail: g.thumbnail,
        servers: [],
        totalPlayers: 0,
        pageUrl: `https://www.roblox.com/games/${encodeURIComponent(g.placeId)}`
      });
    }
    const grp = byPlace.get(g.placeId);
    grp.totalPlayers += g.players;
    if (!grp.thumbnail && g.thumbnail) grp.thumbnail = g.thumbnail;
    grp.servers.push({
      id: g.jobId,
      players: g.players,
      maxPlayers: g.maxPlayers,
      joinUrl: `https://www.roblox.com/games/start?placeId=${encodeURIComponent(g.placeId)}&gameInstanceId=${encodeURIComponent(g.jobId)}&launchData=${encodeURIComponent(token)}`
    });
  }
  const games = [...byPlace.values()]
    .map(grp => {
      grp.servers.sort((a, b) => b.players - a.players);
      grp.serverCount = grp.servers.length;
      grp.bucket = bucketFor(grp.totalPlayers);
      return grp;
    })
    .sort((a, b) => b.totalPlayers - a.totalPlayers);
  res.json({ games });
});

function bucketFor(n) {
  if (n >= 1000) return '1k+';
  if (n >= 100) return '100-1k';
  if (n >= 25) return '25-100';
  return '0-25';
}

// called by the Roblox game server every few seconds to register itself as live
app.post('/api/games/heartbeat', heartbeatLimiter, (req, res) => {
  const { placeId, jobId, name, players, maxPlayers, thumbnail } = req.body || {};
  if (!placeId || !jobId) return res.status(400).json({ error: 'placeId and jobId required' });
  const id = String(jobId).slice(0, 64);
  activeGames.set(id, {
    placeId: String(placeId).slice(0, 32),
    jobId: id,
    name: String(name || 'Untitled').slice(0, 80),
    players: Math.max(0, parseInt(players, 10) || 0),
    maxPlayers: Math.max(0, parseInt(maxPlayers, 10) || 0),
    thumbnail: typeof thumbnail === 'string' ? thumbnail.slice(0, 500) : null,
    lastSeen: Date.now()
  });
  res.json({ ok: true, ttl: Math.floor(HEARTBEAT_TTL / 1000) });
});

// returns the signed-in user's launch token (used to build join URLs and for in-game verification)
app.get('/api/games/my-token', requireUser, (req, res) => {
  const me = req.session.user.username;
  const devs  = readJson(DEVS_FILE, []);
  const users = readJson(USERS_FILE, []);
  let rec = devs.find(d => d.username === me);
  let bucketFile = DEVS_FILE, bucketAll = devs;
  if (!rec) { rec = users.find(u => u.username === me); bucketFile = USERS_FILE; bucketAll = users; }
  if (!rec) return res.status(404).json({ error: 'not found' });
  const token = ensureGameToken(rec, bucketFile, bucketAll);
  res.json({ token });
});

// called by the Roblox game to verify a player's launch token. allows GUI load if the
// associated website account is currently signed in (active within ACTIVITY_WINDOW).
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

// called by the Roblox game when a player executes a script. ties the execution to the
// website account whose token was used to load the gui. devs can view these and join
// the server the script ran in.
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

// dev-only: read execution logs. each entry includes a join url built with the requesting
// dev's launch token so they can hop into the server the script ran in.
app.get('/api/logs', requireDev, (req, res) => {
  const me = req.session.user.username;
  const devs = readJson(DEVS_FILE, []);
  const rec = devs.find(d => d.username === me);
  const token = rec ? ensureGameToken(rec, DEVS_FILE, devs) : '';
  const logs = readJson(LOGS_FILE, []).slice(0, 500).map(l => ({
    ...l,
    joinUrl: l.placeId && l.jobId
      ? `https://www.roblox.com/games/start?placeId=${encodeURIComponent(l.placeId)}&gameInstanceId=${encodeURIComponent(l.jobId)}&launchData=${encodeURIComponent(token)}`
      : null
  }));
  res.json({ logs });
});

// block direct access to gated html files (e.g. /dashboard.html). everything goes
// through the named routes below so the auth gate runs first.
app.use((req, res, next) => {
  if (req.path !== '/index.html' && req.path !== '/login.html' && req.path !== '/signup.html' && /\.html$/i.test(req.path)) {
    return res.status(404).send('not found');
  }
  next();
});
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: [] }));

function gated(file) {
  return (req, res) => {
    if (!req.session.user || !userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/'); });
    }
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
function devOnly(file) {
  return (req, res) => {
    if (!req.session.user || req.session.user.kind !== 'dev' || !userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/login'); });
    }
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/dashboard', gated('dashboard.html'));
app.get('/games',     gated('games.html'));
app.get('/scripts',   gated('scripts.html'));
app.get('/dev',       devOnly('dev.html'));
app.get('/drops',     devOnly('drops.html'));
app.get('/logs',      devOnly('logs.html'));
app.get('/login',     (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/signup',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));

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
