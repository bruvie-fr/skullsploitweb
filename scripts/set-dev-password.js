'use strict';
// Resets a dev's password directly in data/devs.json. Use this on the prod
// server when the bootstrap password is compromised and you need to rotate
// it before logging in via the website.
//
// usage:
//   node scripts/set-dev-password.js <username> <new_password>
//
// example (rotate bruvo on prod):
//   sudo systemctl stop skullsploit
//   node scripts/set-dev-password.js bruvo 'a-fresh-strong-password'
//   sudo systemctl start skullsploit
//
// the password is hashed with bcrypt (10 rounds) before being written.
// nothing is logged or echoed back to the terminal that includes the password.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Args: username, password, optional --data <path-to-devs.json>
let username, password, dataPath;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--data' && process.argv[i + 1]) { dataPath = process.argv[++i]; }
  else if (!username) { username = a; }
  else if (!password) { password = a; }
}
if (!username || !password) {
  console.error('usage: node scripts/set-dev-password.js <username> <new_password> [--data /abs/path/to/devs.json]');
  process.exit(1);
}
if (username.length > 64 || password.length < 8 || password.length > 256) {
  console.error('username max 64 chars; password 8-256 chars');
  process.exit(1);
}

// Search likely locations if --data wasn't given.
const candidates = dataPath ? [dataPath] : [
  path.join(__dirname, '..', 'data', 'devs.json'),
  '/home/ubuntu/skullsploit/data/devs.json',
  '/var/lib/skullsploit/devs.json',
  '/opt/skullsploit/data/devs.json',
];
const FILE = candidates.find(p => fs.existsSync(p));
if (!FILE) {
  console.error('could not find devs.json. tried:');
  for (const c of candidates) console.error('  ' + c);
  console.error('pass the path explicitly:  --data /full/path/to/devs.json');
  console.error('hint: sudo find / -name devs.json -path "*/skullsploit/*" 2>/dev/null');
  process.exit(1);
}
console.log('using ' + FILE);

const devs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const dev = devs.find(d => d.username === username);
if (!dev) {
  console.error(`no dev with username "${username}"`);
  process.exit(1);
}

dev.passwordHash = bcrypt.hashSync(password, 10);
dev.passwordRotatedAt = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(devs, null, 2));

console.log(`password updated for ${username}`);
console.log(`isOwner=${!!dev.isOwner}  rotated=${dev.passwordRotatedAt}`);
