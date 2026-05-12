'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'morph-custom.json');
const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));

let touched = 0, skippedAlready = 0, skippedNoArgs = 0;
for (const [name, entry] of Object.entries(all)) {
  if (!entry || typeof entry !== 'object') continue;
  if (!Array.isArray(entry.args) || entry.args.length === 0) {
    skippedNoArgs++;
    continue;
  }
  if (entry.args.includes('USERNAME')) {
    skippedAlready++;
    continue;
  }
  entry.args = ['USERNAME', ...entry.args];
  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = 'system';
  touched++;
}

fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
console.log(`prepended USERNAME to ${touched} entries`);
console.log(`already had it: ${skippedAlready}`);
console.log(`no args (use default {playerName}): ${skippedNoArgs}`);
