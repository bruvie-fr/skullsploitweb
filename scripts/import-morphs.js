'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: node scripts/import-morphs.js <path/to/morphs.txt>');
  process.exit(1);
}
const srcPath = argv[0];
const outPath = path.join(__dirname, '..', 'data', 'morphs.json');

const text = fs.readFileSync(srcPath, 'utf8');
const lines = text.split('\n');

const rowRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{(.*)\}\s*,?\s*$/;

function parseField(body, key) {
  
  
  const re = new RegExp(`\\b${key}\\s*=\\s*`);
  const m = re.exec(body);
  if (!m) return null;
  let i = m.index + m[0].length;
  
  if (body[i] === '"') {
    
    let j = i + 1;
    while (j < body.length && body[j] !== '"') {
      if (body[j] === '\\') j += 2; else j++;
    }
    return JSON.parse(body.slice(i, j + 1));
  }
  if (body[i] === '{') {
    
    let depth = 0, j = i;
    while (j < body.length) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      j++;
    }
    const inner = body.slice(i + 1, j - 1);
    
    const items = [];
    const sre = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let mm;
    while ((mm = sre.exec(inner))) items.push(mm[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    return items;
  }
  
  let j = i;
  while (j < body.length && /[0-9]/.test(body[j])) j++;
  if (j > i) return Number(body.slice(i, j));
  return null;
}

const morphs = {};
let count = 0, skipped = 0;
for (const raw of lines) {
  const line = raw.replace(/\r$/, '');
  const m = rowRe.exec(line);
  if (!m) continue;
  const name = m[1];
  const body = m[2];
  const id = parseField(body, 'id');
  if (typeof id !== 'number' || !Number.isFinite(id)) { skipped++; continue; }
  const style = parseField(body, 'style');
  const method = parseField(body, 'method');
  const args = parseField(body, 'args');

  const entry = { id, style: style || 'call' };
  if (method) entry.method = method;
  if (Array.isArray(args)) entry.args = args;

  morphs[name] = entry;
  count++;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(morphs, null, 2));
console.log(`wrote ${count} morphs (skipped ${skipped}) -> ${outPath}`);

const styleCount = {};
for (const k in morphs) styleCount[morphs[k].style] = (styleCount[morphs[k].style] || 0) + 1;
console.log('styles:', JSON.stringify(styleCount));
