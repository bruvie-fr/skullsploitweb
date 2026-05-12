'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'morph-custom.json');
const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));

let added = 0, skippedModel = 0, skippedHasArgs = 0;
for (const [name, entry] of Object.entries(all)) {
  if (!entry || typeof entry !== 'object') continue;
  if (entry.style === 'model') { skippedModel++; continue; }
  if (Array.isArray(entry.args) && entry.args.length > 0) { skippedHasArgs++; continue; }
  entry.args = ['USERNAME'];
  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = 'system';
  added++;
}

fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
console.log(`added args=["USERNAME"] to ${added} entries`);
console.log(`already had explicit args: ${skippedHasArgs}`);
console.log(`style=model (no call): ${skippedModel}`);
