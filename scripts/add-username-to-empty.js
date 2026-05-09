'use strict';
// One-shot: add args=["USERNAME"] to every entry that currently has no args
// AND uses a style that calls something (args/colon/call). Skips style=model.
//
// After this, the website's call preview reflects exactly what the runtime
// dispatch produces — no more silent player.Name injection that's invisible
// in the UI.
//
// run: node scripts/add-username-to-empty.js

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
