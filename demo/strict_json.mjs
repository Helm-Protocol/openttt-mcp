// Reject duplicate decoded keys at every object depth before JSON.parse collapses them.
export function parseStrictJson(text, maxDepth = 64) {
  if (typeof text !== 'string') throw new SyntaxError('INVALID_JSON');
  let i = 0;
  const bad = () => { throw new SyntaxError('INVALID_JSON'); };
  const ws = () => { while (i < text.length && /[\x20\t\r\n]/.test(text[i])) i++; };
  function string() {
    const start = i;
    if (text[i++] !== '"') bad();
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') {
        const decoded = JSON.parse(text.slice(start, i));
        // serde_json rejects unpaired surrogates; reject them at HTTP admission too
        // so an accepted Node string cannot terminate the private Rust verifier.
        for (let j = 0; j < decoded.length; j++) {
          const code = decoded.charCodeAt(j);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(++j);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new SyntaxError('INVALID_JSON_UNICODE');
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new SyntaxError('INVALID_JSON_UNICODE');
        }
        return decoded;
      }
      if (c === '\\') { if (i >= text.length) bad(); i++; }
      else if (c.charCodeAt(0) < 32) bad();
    }
    bad();
  }
  function value(depth) {
    if (depth > maxDepth) throw new SyntaxError('JSON_DEPTH_LIMIT');
    ws();
    const c = text[i];
    if (c === '"') { string(); return; }
    if (c === '{') {
      i++; ws(); const keys = new Set();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); const key = string();
        if (keys.has(key)) throw new SyntaxError('DUPLICATE_JSON_KEY');
        keys.add(key); ws(); if (text[i++] !== ':') bad();
        value(depth + 1); ws(); const end = text[i++];
        if (end === '}') return;
        if (end !== ',') bad();
      }
    }
    if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); ws(); const end = text[i++]; if (end === ']') return; if (end !== ',') bad(); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!match) bad(); i += match[0].length;
  }
  value(0); ws(); if (i !== text.length) bad();
  return JSON.parse(text);
}
