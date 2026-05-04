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
const SECRET_FILE  = path.join(DATA_DIR, '.session-secret');

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
  const devs = readJson(DEVS_FILE, []);
  // seeded developer — change username/password here for fresh installs
  if (!devs.find(d => d.username === 'bruvo')) {
    devs.push({
      username: 'bruvo',
      passwordHash: bcrypt.hashSync('Bruvofr@2011', 10),
      createdAt: new Date().toISOString()
    });
    writeJson(DEVS_FILE, devs);
  }
  if (!fs.existsSync(USERS_FILE)) writeJson(USERS_FILE, []);
  if (!fs.existsSync(KEYS_FILE))  writeJson(KEYS_FILE, []);
  if (!fs.existsSync(SCRIPTS_FILE)) writeJson(SCRIPTS_FILE, []);
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
const loginLimiter  = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: 'too many sign-in attempts. try again in a few minutes.' });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 6, message: 'too many account attempts. try again later.' });

function genKey() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `SKL-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20,24)}`;
}
function requireUser(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'sign in to continue' });
  next();
}
function requireDev(req, res, next) {
  if (!req.session.user || req.session.user.kind !== 'dev') return res.status(403).json({ error: 'developers only' });
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
    keyUsed: k.key
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
  if (!user) { user = users.find(u => u.username === username); kind = 'user'; }
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'wrong username or password' });
  }
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

app.post('/api/keys/:key/revoke', requireDev, (req, res) => {
  const keys = readJson(KEYS_FILE, []);
  const e = keys.find(k => k.key === req.params.key);
  if (!e) return res.status(404).json({ error: 'not found' });
  e.revoked = true;
  writeJson(KEYS_FILE, keys);
  res.json({ ok: true });
});

app.delete('/api/keys/:key', requireDev, (req, res) => {
  let keys = readJson(KEYS_FILE, []);
  keys = keys.filter(k => k.key !== req.params.key);
  writeJson(KEYS_FILE, keys);
  res.json({ ok: true });
});

app.get('/api/scripts', requireUser, (req, res) => {
  const scripts = readJson(SCRIPTS_FILE, []);
  const me = req.session.user.username;
  res.json({
    scripts: scripts.map(s => ({
      id: s.id,
      title: s.title,
      tags: s.tags || [],
      author: s.author,
      body: s.body,
      createdAt: s.createdAt,
      likeCount: (s.likes || []).length,
      liked: (s.likes || []).includes(me)
    }))
  });
});

app.post('/api/scripts', requireDev, (req, res) => {
  const { title, tags = [], body } = req.body || {};
  if (typeof title !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'title and body are required' });
  }
  if (!title.trim() || !body.trim()) return res.status(400).json({ error: 'title and body are required' });
  // configurable: max script body size
  if (body.length > 32 * 1024) return res.status(413).json({ error: 'script body too large (max 32 KB)' });

  const rawTags = Array.isArray(tags) ? tags : String(tags).split(',');
  const cleanTags = rawTags
    .map(t => String(t).trim().slice(0, 24))
    .filter(Boolean)
    .slice(0, 10);

  const scripts = readJson(SCRIPTS_FILE, []);
  const script = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 80),
    tags: cleanTags,
    body,
    author: req.session.user.username,
    likes: [],
    createdAt: new Date().toISOString()
  };
  scripts.unshift(script);
  writeJson(SCRIPTS_FILE, scripts);
  res.json({ ok: true, script });
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

app.post('/api/scripts/:id/like', requireUser, (req, res) => {
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

// wire your real games source here — return { games: [{ id, name, players, supported }] }
app.get('/api/games', requireUser, (req, res) => {
  res.json({ games: [] });
});

app.use(express.static(PUBLIC_DIR));

function gated(file) {
  return (req, res) => {
    if (!req.session.user) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
function devOnly(file) {
  return (req, res) => {
    if (!req.session.user || req.session.user.kind !== 'dev') return res.redirect('/login');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/dashboard', gated('dashboard.html'));
app.get('/games',     gated('games.html'));
app.get('/scripts',   gated('scripts.html'));
app.get('/dev',       devOnly('dev.html'));
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
  console.log(`\n  skullsploit running at http://localhost:${PORT}`);
  console.log(`  developer login: bruvo / Bruvofr@2011`);
  console.log(`  add more developers by editing data/devs.json directly`);
  console.log('');
});
