'use strict';
// luaobf.js — source-level Luau obfuscator.
//
// Output is plain Luau that runs as-is. NO dependency on loadstring / load /
// bit32 / debug — works in any Luau environment, including ones where those
// are stripped. Strength comes from making the surface code unreadable, not
// from hiding it inside an encrypted blob.
//
// Honest scope: nothing on a Luau VM is uncrackable. A determined analyst
// with a beautifier and a debugger will eventually walk it. What this layers:
//
//   1. Tokenize, strip comments.
//   2. String literals → entries in a runtime-decoded `_S` table. Each entry
//      is XOR-encrypted with a per-build key; the runtime decoder is plain
//      Luau (no bit32, no loadstring).
//   3. Numeric literals → entries in a `_N` table.
//   4. Scope-aware identifier renaming for `local` declarations and function
//      parameters. Globals, method names, and table field keys are NEVER
//      renamed (those are externally meaningful in Roblox).
//   5. Whitespace compaction.
//
// All transforms preserve semantics. Strings, numbers, control flow, API
// calls (`game:GetService("Players")` etc.) keep their behavior — only the
// readable identifiers and constants are scrambled.

const crypto = require('crypto');

// ----- tokenizer -----
function tokenize(src) {
  const tokens = [];
  const len = src.length;
  let i = 0;

  while (i < len) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      let j = i + 1;
      while (j < len && /\s/.test(src[j])) j++;
      tokens.push({ type: 'ws', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[') {
        const m = matchLongBracket(src, i + 2);
        if (m) {
          tokens.push({ type: 'comment', value: src.slice(i, m.end) });
          i = m.end;
          continue;
        }
      }
      let j = i;
      while (j < len && src[j] !== '\n') j++;
      tokens.push({ type: 'comment', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '[') {
      const m = matchLongBracket(src, i);
      if (m) {
        tokens.push({ type: 'string', kind: 'long', value: src.slice(i, m.end), raw: m.content });
        i = m.end;
        continue;
      }
    }

    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < len) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === quote) { j++; break; }
        if (ch === '\n') { j++; break; }
        j++;
      }
      tokens.push({ type: 'string', kind: 'short', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < len) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') { j++; break; }
        if (ch === '{') {
          let depth = 1;
          j++;
          while (j < len && depth > 0) {
            const k = src[j];
            if (k === '{') depth++;
            else if (k === '}') depth--;
            if (depth > 0) j++;
          }
          if (j < len) j++;
          continue;
        }
        j++;
      }
      tokens.push({ type: 'string', kind: 'interp', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      if (c === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(src[j])) j++;
        if (src[j] === '.') { j++; while (j < len && /[0-9a-fA-F_]/.test(src[j])) j++; }
        if (src[j] === 'p' || src[j] === 'P') {
          j++; if (src[j] === '+' || src[j] === '-') j++;
          while (j < len && isDigit(src[j])) j++;
        }
      } else {
        while (j < len && (isDigit(src[j]) || src[j] === '_')) j++;
        if (src[j] === '.') { j++; while (j < len && (isDigit(src[j]) || src[j] === '_')) j++; }
        if (src[j] === 'e' || src[j] === 'E') {
          j++; if (src[j] === '+' || src[j] === '-') j++;
          while (j < len && isDigit(src[j])) j++;
        }
      }
      tokens.push({ type: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }

    let punct = c;
    const c2 = src[i + 1] || '';
    const c3 = src[i + 2] || '';
    if (c === '.' && c2 === '.' && c3 === '.') punct = '...';
    else if (c === '.' && c2 === '.') punct = '..';
    else if (c === '=' && c2 === '=') punct = '==';
    else if (c === '~' && c2 === '=') punct = '~=';
    else if (c === '<' && c2 === '=') punct = '<=';
    else if (c === '>' && c2 === '=') punct = '>=';
    else if (c === ':' && c2 === ':') punct = '::';
    else if (c === '<' && c2 === '<') punct = '<<';
    else if (c === '>' && c2 === '>') punct = '>>';
    else if (c === '/' && c2 === '/') punct = '//';
    tokens.push({ type: 'punct', value: punct });
    i += punct.length;
  }

  return tokens;
}

function matchLongBracket(src, start) {
  if (src[start] !== '[') return null;
  let i = start + 1;
  let level = 0;
  while (src[i] === '=') { level++; i++; }
  if (src[i] !== '[') return null;
  const closer = ']' + '='.repeat(level) + ']';
  let bodyStart = i + 1;
  if (src[bodyStart] === '\n') bodyStart++;
  const end = src.indexOf(closer, bodyStart);
  if (end < 0) return null;
  return { end: end + closer.length, content: src.slice(bodyStart, end) };
}

function isDigit(c) { return c >= '0' && c <= '9'; }

function emit(tokens) { return tokens.map(t => t.value).join(''); }

function stripComments(tokens) {
  return tokens.filter(t => t.type !== 'comment');
}

// Decode a Lua short-string literal (with surrounding quotes) into its byte content.
function decodeShortString(literal) {
  const quote = literal[0];
  const body = literal.slice(1, literal[literal.length - 1] === quote ? -1 : literal.length);
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c !== '\\') { out += c; i++; continue; }
    const n = body[i + 1];
    if (n === 'a') { out += '\x07'; i += 2; }
    else if (n === 'b') { out += '\b'; i += 2; }
    else if (n === 'f') { out += '\f'; i += 2; }
    else if (n === 'n') { out += '\n'; i += 2; }
    else if (n === 'r') { out += '\r'; i += 2; }
    else if (n === 't') { out += '\t'; i += 2; }
    else if (n === 'v') { out += '\v'; i += 2; }
    else if (n === '\\') { out += '\\'; i += 2; }
    else if (n === '"') { out += '"'; i += 2; }
    else if (n === "'") { out += "'"; i += 2; }
    else if (n === '\n') { out += '\n'; i += 2; }
    else if (n === 'x') {
      const hex = body.slice(i + 2, i + 4);
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else if (n === 'z') {
      i += 2;
      while (i < body.length && /\s/.test(body[i])) i++;
    } else if (/\d/.test(n)) {
      let j = i + 1;
      let num = '';
      while (j < body.length && /\d/.test(body[j]) && num.length < 3) { num += body[j]; j++; }
      out += String.fromCharCode(parseInt(num, 10));
      i = j;
    } else {
      out += c + (n || '');
      i += 2;
    }
  }
  return out;
}

function emitHexStringFromBuffer(buf) {
  let s = '"';
  for (let i = 0; i < buf.length; i++) s += '\\x' + buf[i].toString(16).padStart(2, '0');
  s += '"';
  return s;
}

function xorBuf(buf, key) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}

// ----- scope-aware identifier renaming -----
//
// Lua scoping is straightforward enough that we can do this without a full AST.
// Rules:
//   - `local NAME [, NAME]*`                                       declares locals in CURRENT scope
//   - `local function NAME (PARAMS)`                               NAME → CURRENT scope; opens new scope; PARAMS → NEW scope
//   - `function NAME (PARAMS)`     (no `local`)                    GLOBAL — do NOT rename NAME; opens new scope; PARAMS → NEW
//   - `function (PARAMS)`          (anonymous)                     opens new scope; PARAMS → NEW
//   - `for NAME [, NAME]* = / in ...`                              opens new scope at `do`; NAMES → NEW scope
//   - `do ... end`, `then ... end/elseif/else`, `repeat ... until` open/close scopes
//
// Identifiers we MUST NEVER rename:
//   - the name immediately after `.` or `:`     (table field / method name)
//   - the name in `{ NAME = ... }`              (table constructor key)
//   - any global (anything not declared with `local`)
//   - keywords
//
// NameLookup at every ident occurrence walks the scope stack.

const KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for','function','goto','if',
  'in','local','nil','not','or','repeat','return','then','true','until','while',
  // Luau-specific:
  'continue','export','type'
]);

// Generate obfuscated identifiers. We mix visually-confusable glyphs (O/0/o,
// I/l/1) so a wall of them is unpleasant to scan, plus a random hex tail to
// guarantee no two collide within a single build.
function makeRenameGenerator() {
  const used = new Set();
  const charset = 'O0oIl1';
  return () => {
    for (let attempt = 0; attempt < 32; attempt++) {
      let s = '_';
      for (let i = 0; i < 8; i++) s += charset[Math.floor(Math.random() * charset.length)];
      s += crypto.randomBytes(3).toString('hex');
      if (!used.has(s)) { used.add(s); return s; }
    }
    // pathological fallback
    const fb = '_' + crypto.randomBytes(8).toString('hex');
    used.add(fb); return fb;
  };
}

// Walk significant tokens (skip ws/comments). Returns the array and an index map back to original.
function nonTrivial(tokens) {
  const idx = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'ws' && tokens[i].type !== 'comment') idx.push(i);
  }
  return idx;
}

function renameLocals(tokens) {
  const sig = nonTrivial(tokens);
  const get = k => sig[k] !== undefined ? tokens[sig[k]] : null;
  const isPunct = (t, v) => t && t.type === 'punct' && t.value === v;
  const isIdent = (t) => t && t.type === 'ident' && !KEYWORDS.has(t.value);
  const isKw = (t, v) => t && t.type === 'ident' && t.value === v;

  const gen = makeRenameGenerator();
  const scopes = [new Map()]; // stack
  const top = () => scopes[scopes.length - 1];
  const push = () => scopes.push(new Map());
  const pop = () => scopes.length > 1 && scopes.pop();

  // For each significant ident, decide if it's a renaming-eligible reference.
  // We walk in two synchronized cursors: token-stream order with declaration handling.
  // To avoid renaming method/field names, we look at the PRECEDING significant token.
  function lookup(name) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return scopes[i].get(name);
    }
    return null;
  }
  function declare(name) {
    if (!name || KEYWORDS.has(name)) return null;
    // shadow: same name in same scope reuses same alias to avoid breaking redeclare semantics
    if (top().has(name)) return top().get(name);
    const alias = gen();
    top().set(name, alias);
    return alias;
  }

  // Block-opening keywords push a scope when their corresponding "body start" is seen.
  // To keep it simple and robust we push on `do`, `then`, `repeat`, function `(...)` (after we read its params),
  // and pop on `end`, `until`, `elseif`, `else` (the elseif/else cases re-open immediately).

  // First pass: walk significant tokens, mark what each ident references (declare/use/skip),
  // store the rename decisions on the token objects directly.
  for (let k = 0; k < sig.length; k++) {
    const idx = sig[k];
    const t = tokens[idx];
    const prev = get(k - 1);
    const next = get(k + 1);

    // ----- scope open/close -----
    if (isKw(t, 'do')) { push(); continue; }
    if (isKw(t, 'then')) { push(); continue; }
    if (isKw(t, 'repeat')) { push(); continue; }
    if (isKw(t, 'end') || isKw(t, 'until')) { pop(); continue; }
    if (isKw(t, 'else')) { pop(); push(); continue; }
    if (isKw(t, 'elseif')) { pop(); push(); continue; }

    // ----- declarations -----
    if (isKw(t, 'local')) {
      // Two shapes:
      //   local function NAME(PARAMS)
      //   local NAME [, NAME]* [= ...]
      let nk = k + 1;
      let after = get(nk);
      if (isKw(after, 'function')) {
        // local function NAME (...)
        nk++;
        const nameTok = get(nk);
        if (isIdent(nameTok)) {
          const alias = declare(nameTok.value);
          if (alias) nameTok._rename = alias;
        }
        // open the function scope; collect params
        nk++;
        const paren = get(nk);
        if (isPunct(paren, '(')) {
          push();
          nk++;
          while (true) {
            const pt = get(nk);
            if (!pt) break;
            if (isPunct(pt, ')')) break;
            if (isPunct(pt, ',')) { nk++; continue; }
            if (isIdent(pt)) {
              const alias = declare(pt.value);
              if (alias) pt._rename = alias;
            }
            nk++;
          }
          // skip past the `)`
        }
        k = nk;
        continue;
      } else {
        // local NAME [, NAME]* — keep collecting names until non-comma non-ident
        nk = k + 1;
        // skip optional Luau attribute: `local <const>`
        let aTok = get(nk);
        if (isPunct(aTok, '<')) {
          while (nk < sig.length && !isPunct(get(nk), '>')) nk++;
          nk++;
        }
        while (true) {
          const nameTok = get(nk);
          if (!isIdent(nameTok)) break;
          const alias = declare(nameTok.value);
          if (alias) nameTok._rename = alias;
          nk++;
          // optional Luau type annotation `: T` — skip until we hit = , or end-of-list
          if (isPunct(get(nk), ':')) {
            nk++;
            // skip type expression — anything until `=`, `,`, or newline-significant boundary.
            // we approximate by skipping until we see `=` or `,` at our current "depth 0".
            let depth = 0;
            while (nk < sig.length) {
              const tt = get(nk);
              if (depth === 0 && (isPunct(tt, '=') || isPunct(tt, ',') || isKw(tt, 'do') || isKw(tt, 'then') || isKw(tt, 'end'))) break;
              if (isPunct(tt, '<') || isPunct(tt, '(') || isPunct(tt, '{')) depth++;
              if (isPunct(tt, '>') || isPunct(tt, ')') || isPunct(tt, '}')) depth--;
              nk++;
            }
          }
          if (isPunct(get(nk), ',')) { nk++; continue; }
          break;
        }
        k = nk - 1;
        continue;
      }
    }

    // ----- function declaration / expression -----
    if (isKw(t, 'function')) {
      // Could be:
      //   function NAME (...)               GLOBAL — skip NAME
      //   function NAME.foo.bar (...)        member — skip
      //   function obj:method (...)          method — skip
      //   function (...)                     anon — push scope, params local
      let nk = k + 1;
      // walk through `NAME(.NAME)*(:NAME)?` if any
      if (isIdent(get(nk))) {
        nk++;
        while (isPunct(get(nk), '.') || isPunct(get(nk), ':')) {
          nk++;
          if (isIdent(get(nk))) nk++;
        }
      }
      const paren = get(nk);
      if (isPunct(paren, '(')) {
        push();
        nk++;
        while (true) {
          const pt = get(nk);
          if (!pt) break;
          if (isPunct(pt, ')')) break;
          if (isPunct(pt, ',')) { nk++; continue; }
          if (isIdent(pt)) {
            const alias = declare(pt.value);
            if (alias) pt._rename = alias;
          }
          nk++;
        }
      }
      k = nk;
      continue;
    }

    // ----- for loop variable bindings -----
    if (isKw(t, 'for')) {
      // for NAME [, NAME]* = / in ...
      // We need the names declared in the loop body scope. Push scope here; pop on matching `end` (handled above).
      push();
      let nk = k + 1;
      while (true) {
        const nameTok = get(nk);
        if (!isIdent(nameTok)) break;
        const alias = declare(nameTok.value);
        if (alias) nameTok._rename = alias;
        nk++;
        // optional type annotation
        if (isPunct(get(nk), ':')) {
          nk++;
          let depth = 0;
          while (nk < sig.length) {
            const tt = get(nk);
            if (depth === 0 && (isPunct(tt, '=') || isPunct(tt, ',') || isKw(tt, 'in'))) break;
            if (isPunct(tt, '<') || isPunct(tt, '(') || isPunct(tt, '{')) depth++;
            if (isPunct(tt, '>') || isPunct(tt, ')') || isPunct(tt, '}')) depth--;
            nk++;
          }
        }
        if (isPunct(get(nk), ',')) { nk++; continue; }
        break;
      }
      k = nk - 1;
      continue;
    }

    // ----- ident references (uses) -----
    if (isIdent(t)) {
      // skip member access: prev is `.` or `:`
      if (isPunct(prev, '.') || isPunct(prev, ':')) continue;
      // skip table key form `{ NAME = ...` or `, NAME = ...` inside a `{}` block.
      // Heuristic: if next is `=` and prev is `{` or `,` and we're inside a `{`, it's a table key.
      // Without full bracket tracking we use a conservative version: prev is `{` or `,`, next is `=`,
      // AND the next-next isn't `=` (so not `==`).
      if ((isPunct(prev, '{') || isPunct(prev, ',')) && isPunct(next, '=')) continue;

      const alias = lookup(t.value);
      if (alias) t._rename = alias;
    }
  }

  // Apply renames into token values.
  for (const tok of tokens) {
    if (tok && tok._rename) { tok.value = tok._rename; delete tok._rename; }
  }
  return tokens;
}

// Rewrite `obj.method(args)` → `obj["method"](args)` and
//         `obj:method(args)` → `obj["method"](obj, args)`.
//
// After this pass, every method-call name becomes a plain string literal.
// The string-encryption pass downstream then sweeps those names into the
// encrypted _S table, so `HttpService:GetAsync` no longer survives as
// plaintext in the output — it becomes `HttpService[_S[N]](HttpService, ...)`.
//
// Safety rules:
//   - Only rewrite when the call is real: pattern is IDENT (.|:) IDENT '('.
//   - For `:` form, the receiver must be a simple identifier (otherwise
//     duplicating it as the first arg could cause side-effects or be hard to
//     emit).
//   - Skip `function IDENT:method(...) end` definition form — rewriting it
//     would break the implicit `self` parameter.
//   - We allow `function IDENT.method(...) end` definitions; those are
//     semantically equivalent to `function IDENT["method"](...) end`.
function rewriteMethodCalls(tokens) {
  const sig = nonTrivial(tokens);
  const get = k => sig[k] !== undefined ? tokens[sig[k]] : null;
  const isPunct = (t, v) => t && t.type === 'punct' && t.value === v;
  const isIdent = (t) => t && t.type === 'ident' && !KEYWORDS.has(t.value);
  const isKw = (t, v) => t && t.type === 'ident' && t.value === v;

  // Collect rewrites by original token-index so we can apply from the END
  // backwards (avoids invalidating indices when we splice).
  const rewrites = [];
  for (let k = 0; k + 3 < sig.length; k++) {
    const a = get(k);          // receiver IDENT
    const dot = get(k + 1);    // . or :
    const m = get(k + 2);      // method IDENT
    const lp = get(k + 3);     // (
    if (!isIdent(a)) continue;
    if (!(isPunct(dot, '.') || isPunct(dot, ':'))) continue;
    if (!isIdent(m)) continue;
    if (!isPunct(lp, '(')) continue;
    // Skip `function obj:method(...)` definition — would lose implicit self
    const before = get(k - 1);
    const isColon = dot.value === ':';
    if (isColon && isKw(before, 'function')) continue;
    rewrites.push({
      aTokIdx: sig[k],
      dotTokIdx: sig[k + 1],
      methTokIdx: sig[k + 2],
      lpTokIdx: sig[k + 3],
      isColon,
    });
    // Don't advance — overlapping patterns like `a.b.c(x)` should also
    // rewrite the `.c(` part, which they do because our pattern starts at
    // `b` (an IDENT) and matches.
  }

  // Apply rewrites from end → start so token indices stay valid.
  for (let r = rewrites.length - 1; r >= 0; r--) {
    const { aTokIdx, dotTokIdx, methTokIdx, lpTokIdx, isColon } = rewrites[r];
    const methodName = tokens[methTokIdx].value;
    const receiverName = tokens[aTokIdx].value;

    // Replace `.method` (or `:method`) with `["method"]`
    tokens[dotTokIdx] = { type: 'punct', value: '[' };
    tokens[methTokIdx] = { type: 'string', kind: 'short', value: '"' + methodName + '"' };
    // Insert `]` right after the (former) method ident.
    tokens.splice(methTokIdx + 1, 0, { type: 'punct', value: ']' });

    if (isColon) {
      // The `(` is now at lpTokIdx + 1 (due to the splice above, which was at
      // methTokIdx + 1 ≤ lpTokIdx).
      const newLp = lpTokIdx + 1;
      // Insert receiver as first arg. If args list is empty, no trailing comma.
      let after = newLp + 1;
      while (after < tokens.length && tokens[after].type === 'ws') after++;
      const isEmpty = tokens[after] && tokens[after].type === 'punct' && tokens[after].value === ')';
      const inserts = [{ type: 'ident', value: receiverName }];
      if (!isEmpty) inserts.push({ type: 'punct', value: ',' });
      tokens.splice(newLp + 1, 0, ...inserts);
    }
  }

  return tokens;
}

// Replace string literals (short + long) with `_S[N]` references. Returns the byte buffers
// of original content for embedding in the prologue.
function indirectStrings(tokens, helperName) {
  const table = [];
  const out = tokens.map(t => {
    if (t.type !== 'string') return t;
    if (t.kind === 'long') {
      table.push(Buffer.from(t.raw, 'utf8'));
      return { type: 'ident', value: `${helperName}[${table.length}]` };
    }
    if (t.kind === 'short') {
      table.push(Buffer.from(decodeShortString(t.value), 'binary'));
      return { type: 'ident', value: `${helperName}[${table.length}]` };
    }
    // Backtick interpolation strings reference local vars; rewriting them safely
    // requires understanding the inner expressions. Leave them alone.
    return t;
  });
  return { tokens: out, table };
}

// Replace numeric literals with `_N[N]` references.
function indirectNumbers(tokens, helperName) {
  const table = [];
  const out = tokens.map(t => {
    if (t.type !== 'number') return t;
    table.push(t.value);
    return { type: 'ident', value: `${helperName}[${table.length}]` };
  });
  return { tokens: out, table };
}

// Compact whitespace down to the minimum required to keep adjacent tokens separable.
// Two adjacent ident/keyword/number tokens need at least one space; punct adjacencies are fine.
function compactWhitespace(tokens) {
  // Find the nearest non-whitespace token before/after index i. Comments are
  // already stripped at this point, so the only thing we skip is consecutive
  // ws tokens (which appear where comments USED TO BE between statements).
  function prevNonWs(idx) {
    for (let k = idx - 1; k >= 0; k--) {
      if (tokens[k].type !== 'ws') return tokens[k];
    }
    return null;
  }
  function nextNonWs(idx) {
    for (let k = idx + 1; k < tokens.length; k++) {
      if (tokens[k].type !== 'ws') return tokens[k];
    }
    return null;
  }

  const out = [];
  let pendingSep = false; // whether we've already queued a separator for a run of ws tokens
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'ws') {
      if (pendingSep) continue;
      const prev = prevNonWs(i);
      const next = nextNonWs(i);
      if (!prev || !next) continue;
      const needsSep =
        (prev.type === 'ident' || prev.type === 'number') &&
        (next.type === 'ident' || next.type === 'number');
      if (needsSep) {
        out.push({ type: 'ws', value: ' ' });
        pendingSep = true;
      }
      continue;
    }
    out.push(t);
    pendingSep = false;
  }
  return out;
}

function rname() { return '_' + crypto.randomBytes(4).toString('hex'); }

// ----- main -----

function obfuscate(source, opts = {}) {
  if (typeof source !== 'string') return { ok: false, error: 'source must be a string' };
  if (!source.trim()) return { ok: false, error: 'source is empty' };
  if (source.length > 200_000) return { ok: false, error: 'source too large (max 200kb)' };

  const opt = {
    encryptStrings: opts.encryptStrings !== false,
    encryptCalls:   opts.encryptCalls   !== false,
    indirectNumbers: opts.indirectNumbers !== false,
    renameLocals: opts.renameLocals !== false,
    stripComments: opts.stripComments !== false,
    minify: opts.minify !== false,
  };

  let tokens;
  try { tokens = tokenize(source); }
  catch (e) { return { ok: false, error: 'tokenize failed: ' + (e && e.message || e) }; }

  if (opt.stripComments) tokens = stripComments(tokens);

  // Rename FIRST, while string and number literals are still visible (so the
  // string-table-helper name we generate later can never collide with a real ident).
  if (opt.renameLocals) {
    try { tokens = renameLocals(tokens); }
    catch (e) { return { ok: false, error: 'rename failed: ' + (e && e.message || e) }; }
  }

  // Rewrite method/field call names to string-indexed lookups. Must run BEFORE
  // string encryption so the freshly-emitted method-name string literals get
  // swept into the encrypted table just like real literals.
  if (opt.encryptCalls) {
    try { tokens = rewriteMethodCalls(tokens); }
    catch (e) { return { ok: false, error: 'rewriteMethodCalls failed: ' + (e && e.message || e) }; }
  }

  let stringTable = null, stringHelper = null, stringKey = null;
  if (opt.encryptStrings) {
    stringHelper = rname();
    const r = indirectStrings(tokens, stringHelper);
    tokens = r.tokens;
    stringTable = r.table;
    stringKey = crypto.randomBytes(16);
  }

  let numberTable = null, numberHelper = null;
  if (opt.indirectNumbers) {
    numberHelper = rname();
    const r = indirectNumbers(tokens, numberHelper);
    tokens = r.tokens;
    numberTable = r.table;
  }

  if (opt.minify) tokens = compactWhitespace(tokens);

  const body = emit(tokens);

  // ----- prologue: runtime-decoded string table + number table -----
  const lines = [];

  if (stringTable && stringTable.length > 0) {
    const xorEntries = stringTable.map(buf => emitHexStringFromBuffer(xorBuf(buf, stringKey)));
    // Pure-Luau XOR (no bit32 dependency). Each call is O(8) per byte; fine for one-time decode.
    const x = rname(); const k = rname(); const e = rname(); const o = rname();
    const i = rname(); const j = rname(); const s = rname(); const b = rname();
    const a = rname(); const c = rname(); const r = rname(); const p = rname();
    lines.push(
      `local ${stringHelper}=(function()` +
      `local ${k}=${emitHexStringFromBuffer(stringKey)};` +
      `local ${e}={${xorEntries.join(',')}};` +
      `local function ${x}(${a},${c})` +
        `local ${r},${p}=0,1;` +
        `for ${i}=1,8 do ` +
          `local ${s},${b}=${a}%2,${c}%2;` +
          `if ${s}~=${b} then ${r}=${r}+${p} end;` +
          `${a}=(${a}-${s})/2;${c}=(${c}-${b})/2;${p}=${p}*2 ` +
        `end;` +
        `return ${r} ` +
      `end;` +
      `local ${o}={};` +
      `for ${i}=1,#${e} do ` +
        `local ${s},${b}=${e}[${i}],{};` +
        `for ${j}=1,#${s} do ` +
          `${b}[${j}]=string.char(${x}(${s}:byte(${j}),${k}:byte(((${j}-1)%#${k})+1)))` +
        ` end;` +
        `${o}[${i}]=table.concat(${b}) ` +
      `end;` +
      `return ${o} ` +
      `end)();`
    );
  }

  if (numberTable && numberTable.length > 0) {
    lines.push(`local ${numberHelper}={${numberTable.join(',')}};`);
  }

  const prologue = lines.join('');

  const banner =
    `-- skullsploit obfuscator output (source-level, no loadstring)\n` +
    `-- ${stringTable ? stringTable.length + ' strings' : 'strings kept'}` +
    `, ${numberTable ? numberTable.length + ' numbers' : 'numbers kept'}` +
    `, locals ${opt.renameLocals ? 'renamed' : 'kept'}` +
    `, calls ${opt.encryptCalls ? 'rewritten' : 'kept'}\n` +
    `-- not uncrackable. layered enough to keep skids out.\n`;

  return {
    ok: true,
    output: banner + prologue + body,
    stats: {
      sourceBytes: Buffer.byteLength(source, 'utf8'),
      outputBytes: Buffer.byteLength(banner + prologue + body, 'utf8'),
      strings: stringTable ? stringTable.length : 0,
      numbers: numberTable ? numberTable.length : 0,
      renamedLocals: !!opt.renameLocals,
      encryptedCalls: !!opt.encryptCalls,
      stripped: opt.stripComments,
    }
  };
}

module.exports = {
  obfuscate,
  tokenize,
  _internal: { decodeShortString, matchLongBracket, renameLocals, rewriteMethodCalls, indirectStrings, indirectNumbers, compactWhitespace }
};
