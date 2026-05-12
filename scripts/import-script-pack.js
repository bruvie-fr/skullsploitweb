'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '--help') {
  console.error('usage: node scripts/import-script-pack.js <input.txt> [--dry] [--max N]');
  process.exit(1);
}
const inputPath = argv[0];
const dry = argv.includes('--dry');
const maxIdx = argv.indexOf('--max');
const MAX_ENTRIES = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : Infinity;

const OUT_PATH = path.join(__dirname, '..', 'data', 'morph-custom.json');

const USERNAME_HINTS = new Set(['LuaGunsX', 'username', 'USER', 'YourName', 'YOURNAME']);

const NAME_RE = /^[A-Za-z0-9_\- ]{1,40}$/;

function parseArgs(body) {
  const out = [];
  let i = 0;
  const len = body.length;
  while (i < len) {
    while (i < len && /\s/.test(body[i])) i++;
    if (i >= len) break;
    const c = body[i];
    
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1, s = '';
      while (j < len && body[j] !== q) {
        if (body[j] === '\\' && j + 1 < len) { s += body[j + 1]; j += 2; }
        else { s += body[j]; j++; }
      }
      if (body[j] !== q) return null;
      out.push(s);
      i = j + 1;
    }
    
    else if (/[\d\-+]/.test(c)) {
      let j = i;
      while (j < len && /[\d\-+.eExX0-9a-fA-F]/.test(body[j])) j++;
      const n = Number(body.slice(i, j));
      if (!Number.isFinite(n)) return null;
      out.push(n);
      i = j;
    }
    
    else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(body[j])) j++;
      const word = body.slice(i, j);
      if (word === 'true') out.push(true);
      else if (word === 'false') out.push(false);
      else if (word === 'nil') {} 
      else return null;
      i = j;
    }
    else return null;
    
    while (i < len && /\s/.test(body[i])) i++;
    if (i < len && body[i] === ',') { i++; }
    else if (i < len) return null;
  }
  return out;
}

function findMatchingParen(s, start) {
  if (s[start] !== '(') return -1;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const LINE_RE = /^require\((\d+)\)/;

function parseLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').trim();
  if (!line || line.startsWith('--')) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;

  const id = Number(m[1]);
  if (!Number.isFinite(id) || id <= 0) return null;

  let rest = line.slice(m[0].length);
  let style = 'model';
  let method;
  let args = null;

  
  const dotColon = rest.match(/^([.:])([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (dotColon) {
    style = dotColon[1] === '.' ? 'args' : 'colon';
    method = dotColon[2];
    rest = rest.slice(dotColon[0].length);
  }

  
  if (rest.startsWith('(')) {
    const close = findMatchingParen(rest, 0);
    if (close < 0) return null;
    const inner = rest.slice(1, close);
    args = parseArgs(inner);
    if (args === null) return null;
    rest = rest.slice(close + 1);

    
    if (style === 'model') style = 'call';
  }

  
  let name = rest.trim();
  
  name = name.replace(/^[-\s]+/, '').trim();
  if (!name) return null;

  
  if (args) {
    args = args.map(a => (typeof a === 'string' && USERNAME_HINTS.has(a)) ? 'USERNAME' : a);
  }

  
  
  name = name.replace(/[^A-Za-z0-9_\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!NAME_RE.test(name)) return null;
  if (name.length < 3) return null;

  const entry = { id, style };
  if (method) entry.method = method;
  if (args && args.length > 0) entry.args = args;
  return { name, entry };
}

async function main() {
  if (!fs.existsSync(inputPath)) {
    console.error('input file not found:', inputPath);
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  const existingLower = new Set(Object.keys(existing).map(k => k.toLowerCase()));

  const adding = new Map(); 
  let scanned = 0, parsed = 0, skippedDup = 0, skippedInvalid = 0, skippedExisting = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    scanned++;
    const r = parseLine(line);
    if (!r) { skippedInvalid++; continue; }
    parsed++;
    const lk = r.name.toLowerCase();
    if (existingLower.has(lk)) { skippedExisting++; continue; }
    if (adding.has(lk)) { skippedDup++; continue; }
    if (adding.size >= MAX_ENTRIES) continue;
    adding.set(lk, r);
  }

  const stamp = new Date().toISOString();
  let added = 0;
  for (const { name, entry } of adding.values()) {
    existing[name] = {
      ...entry,
      addedBy: 'system',
      addedAt: stamp,
    };
    added++;
  }

  console.log('scanned lines: ' + scanned);
  console.log('parseable    : ' + parsed);
  console.log('skipped (already in morph-custom.json): ' + skippedExisting);
  console.log('skipped (duplicate within input)      : ' + skippedDup);
  console.log('skipped (unparseable/invalid name)    : ' + skippedInvalid);
  console.log('added        : ' + added);
  console.log('total entries after merge: ' + Object.keys(existing).length);

  if (dry) {
    console.log();
    console.log('--dry: writing nothing. sample of what would be added (first 25):');
    let i = 0;
    for (const { name, entry } of adding.values()) {
      if (i++ >= 25) break;
      console.log('  ' + name.padEnd(42) + JSON.stringify(entry));
    }
  } else {
    fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2));
    console.log();
    console.log('wrote ' + OUT_PATH);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
