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

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('usage: node scripts/set-dev-password.js <username> <new_password>');
  process.exit(1);
}
if (username.length > 64 || password.length < 8 || password.length > 256) {
  console.error('username max 64 chars; password 8-256 chars');
  process.exit(1);
}

const FILE = path.join(__dirname, '..', 'data', 'devs.json');
if (!fs.existsSync(FILE)) {
  console.error('data/devs.json missing — has the server ever been run?');
  process.exit(1);
}

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
