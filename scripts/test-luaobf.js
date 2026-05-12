'use strict';

const { obfuscate, _internal } = require('../lib/luaobf');

const cases = [
  { name: 'hello world',         src: `print("hello world")` },
  { name: 'multiline + comment', src: `
-- this is a comment
local x = 42
local s = "the answer is " .. tostring(x)
print(s)
--[[ block comment ]]
print("done")
  ` },
  { name: 'long string',         src: `local html = [[<div>hi</div>]]
print(html)` },
  { name: 'luau types',          src: `
local function add(a: number, b: number): number
  return a + b
end
print(add(2, 3))
  ` },
  { name: 'backtick interp',     src: `
local name = "claude"
print(\`hello, {name}!\`)
  ` },
  { name: 'roblox-ish',          src: `
local Players = game:GetService("Players")
local function notify(msg)
  print("[skull]", msg)
end
notify("loaded")
  ` },
  { name: 'method calls',        src: `
local t = {}
function t.foo(self, x) return self.value + x end
function t:bar(x) return self.value * x end
local o = setmetatable({value = 10}, {__index = t})
print(o:bar(5), o:foo(2))
  ` },
  { name: 'for loops',           src: `
for i = 1, 10 do
  for k, v in pairs({a = 1, b = 2}) do
    print(i, k, v)
  end
end
  ` },
];

let pass = 0, fail = 0;
for (const c of cases) {
  process.stdout.write(`- ${c.name.padEnd(24)} `);
  try {
    const r = obfuscate(c.src);
    if (!r.ok) { console.log('FAIL: ' + r.error); fail++; continue; }
    
    const code = r.output.replace(/^--[^\n]*\n/gm, '');
    if (/\bloadstring\b|\bload\s*\(/.test(code)) { console.log('FAIL: loadstring leaked'); fail++; continue; }
    if (/\bbit32\b/.test(code))                  { console.log('FAIL: bit32 leaked');     fail++; continue; }
    console.log(`ok  ${r.stats.sourceBytes}b → ${r.stats.outputBytes}b  s=${r.stats.strings} n=${r.stats.numbers}`);
    pass++;
  } catch (e) {
    console.log('THROW: ' + e.message);
    fail++;
  }
}

console.log('');
console.log(`${pass} pass, ${fail} fail`);

console.log('\n----- sample output (multiline + comment) -----');
console.log(obfuscate(cases[1].src).output);

const r2 = obfuscate(`
local Players = game:GetService("Players")
local me = Players.LocalPlayer
local svc = me:GetMouse()
print(svc)
`).output;
console.log('\n----- rename-safety output -----');
console.log(r2);
const ok =
  r2.includes('GetService') &&
  r2.includes('LocalPlayer') &&
  r2.includes('GetMouse') &&
  r2.includes('game:') &&
  /Players\b/.test(r2); 
console.log('field/method names preserved:', r2.includes('GetService') && r2.includes('LocalPlayer') && r2.includes('GetMouse') ? 'ok' : 'FAIL');
console.log('local vars renamed:', !/local Players/.test(r2) ? 'ok' : 'FAIL — locals not renamed');

process.exit(fail === 0 ? 0 : 1);
