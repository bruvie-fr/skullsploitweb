'use strict';

const fs = require('fs');
const path = require('path');

let threshold = 3;
const tIdx = process.argv.indexOf('--threshold');
if (tIdx >= 0) threshold = Number(process.argv[tIdx + 1]) || threshold;

const FILE = path.join(__dirname, '..', 'data', 'morph-custom.json');
const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const NAME_LIKE = /^[A-Za-z0-9_]{3,20}$/;

const firstArgCounts = new Map();
for (const e of Object.values(all)) {
  if (e && Array.isArray(e.args) && e.args.length > 0 && typeof e.args[0] === 'string') {
    const v = e.args[0];
    firstArgCounts.set(v, (firstArgCounts.get(v) || 0) + 1);
  }
}

const top = [...firstArgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('Top 25 first-arg values (count → value):');
for (const [v, c] of top) console.log('  ' + String(c).padStart(5) + '  ' + JSON.stringify(v));
console.log();

let filledEmpty = 0, replacedFirst = 0, skipped = 0, alreadyHadUsername = 0;
for (const [name, e] of Object.entries(all)) {
  if (!e || typeof e !== 'object') continue;
  if (e.style === 'model') { skipped++; continue; }

  
  if (!Array.isArray(e.args) || e.args.length === 0) {
    e.args = ['USERNAME'];
    e.updatedAt = new Date().toISOString();
    e.updatedBy = 'system';
    filledEmpty++;
    continue;
  }

  
  if (e.args.includes('USERNAME')) { alreadyHadUsername++; continue; }

  
  const first = e.args[0];
  if (typeof first === 'string' && NAME_LIKE.test(first)) {
    const count = firstArgCounts.get(first) || 0;
    if (count >= threshold) {
      e.args = ['USERNAME', ...e.args.slice(1)];
      e.updatedAt = new Date().toISOString();
      e.updatedBy = 'system';
      replacedFirst++;
      continue;
    }
  }

  skipped++;
}

fs.writeFileSync(FILE, JSON.stringify(all, null, 2));

console.log('filled empty args with [USERNAME]: ' + filledEmpty);
console.log('replaced first arg with USERNAME (placeholder author names): ' + replacedFirst);
console.log('already had USERNAME (untouched): ' + alreadyHadUsername);
console.log('skipped (style=model or non-placeholder first arg): ' + skipped);
console.log('wrote ' + FILE);
