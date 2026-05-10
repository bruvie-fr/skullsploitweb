const k = require('crypto').randomBytes(32);
const hexStr = k.toString('hex');
const luaStr = '"' + Array.from(k).map(b => '\\x' + b.toString(16).padStart(2, '0')).join('') + '"';
console.log('Server side (hex string):');
console.log('  ' + hexStr);
console.log();
console.log('Lua side (\\xNN string for MainModule):');
console.log('  ' + luaStr);
