'use strict';
// Re-parse the original script-pack input file to identify entries whose
// require call had ZERO arguments. Those scripts don't take a username
// parameter at all — passing one breaks them.
//
// For each such entry already in data/morph-custom.json, set
// `noUsername: true` and clear out the args we wrongly filled.
//
// usage: node scripts/mark-no-username.js <input.txt>

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node scripts/mark-no-username.js <input.txt>');
  process.exit(1);
}

const FILE = path.join(__dirname, '..', 'data', 'morph-custom.json');
const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const NAME_RE = /^[A-Za-z0-9_\- ]{1,40}$/;
const LINE_RE = /^require\((\d+)\)/;

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
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function normalizeDisplayName(name) {
  return name.replace(/[^A-Za-z0-9_\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Parse a single line. Returns { name, hadEmptyArgs } or null.
function parseLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').trim();
  if (!line || line.startsWith('--')) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  let rest = line.slice(m[0].length);
  let style = 'model';
  const dotColon = rest.match(/^([.:])([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (dotColon) {
    style = dotColon[1] === '.' ? 'args' : 'colon';
    rest = rest.slice(dotColon[0].length);
  }
  let hadEmptyArgs = true; // true if zero args, false if any args present
  let hadParens = false;
  if (rest.startsWith('(')) {
    hadParens = true;
    const close = findMatchingParen(rest, 0);
    if (close < 0) return null;
    const inner = rest.slice(1, close).trim();
    hadEmptyArgs = inner.length === 0;
    rest = rest.slice(close + 1);
    if (style === 'model') style = 'call';
  } else {
    // No parens at all — definitely no args (style=model)
    hadEmptyArgs = true;
  }
  let name = rest.trim().replace(/^[-\s]+/, '').trim();
  if (!name) return null;
  name = normalizeDisplayName(name);
  if (!NAME_RE.test(name) || name.length < 3) return null;
  return { name, hadEmptyArgs, hadParens, style };
}

async function main() {
  if (!fs.existsSync(inputPath)) { console.error('input file not found:', inputPath); process.exit(1); }

  // Names where the ORIGINAL line had no args (just (), or no parens at all).
  // Use Map<lowername, true> for case-insensitive matching against morph-custom.
  const emptyArgsNames = new Map();
  // Names where the original line DID have args — these are scripts that take args,
  // so don't mark them noUsername even if duplicate names also have empty-arg variants.
  const hadArgsNames = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let scanned = 0;
  for await (const line of rl) {
    scanned++;
    const r = parseLine(line);
    if (!r) continue;
    const lk = r.name.toLowerCase();
    if (r.hadEmptyArgs && r.hadParens) {
      // require(X).method() — had () but nothing inside
      if (!hadArgsNames.has(lk)) emptyArgsNames.set(lk, true);
    } else if (!r.hadParens && r.style !== 'model') {
      // require(X).method <name>  — has a method but the script pack omitted
      // the (). These got style=args with no args field at import time and
      // were wrongly filled with [USERNAME] by normalize-usernames.
      if (!hadArgsNames.has(lk)) emptyArgsNames.set(lk, true);
    } else if (!r.hadParens) {
      // require(X) <name>  — pure model style, no call, no args. Already correct.
    } else {
      // Had args
      hadArgsNames.set(lk, true);
      emptyArgsNames.delete(lk);
    }
  }
  console.log('lines scanned: ' + scanned);
  console.log('names with original empty () in script pack: ' + emptyArgsNames.size);
  console.log('names with original args in script pack: ' + hadArgsNames.size);

  // Now mark matching entries in morph-custom.json
  let marked = 0, skippedAlreadyMarked = 0, notFound = 0;
  const stamp = new Date().toISOString();
  for (const lk of emptyArgsNames.keys()) {
    // Find the actual case-preserved key in morph-custom
    let key = null;
    for (const k of Object.keys(all)) {
      if (k.toLowerCase() === lk) { key = k; break; }
    }
    if (!key) { notFound++; continue; }
    const e = all[key];
    if (e.noUsername) { skippedAlreadyMarked++; continue; }
    e.noUsername = true;
    delete e.args; // remove the wrongly-filled USERNAME
    e.updatedAt = stamp;
    e.updatedBy = 'system';
    marked++;
  }
  console.log('marked noUsername=true: ' + marked);
  console.log('already marked: ' + skippedAlreadyMarked);
  console.log('not in morph-custom (orphan names): ' + notFound);

  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  console.log('wrote ' + FILE);
}
main().catch(e => { console.error(e); process.exit(1); });
