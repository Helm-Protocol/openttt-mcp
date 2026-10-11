import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson } from '../demo/strict_json.mjs';
import { createMemoryDbReplayStore } from '../demo/memorydb_replay.mjs';

test('decoded duplicate keys rejected before collapse', () => {
  for (const input of ['{"amount":1,"amount":2}', '{"action":{"amount":1,"\\u0061mount":2}}', '[{"x":1,"x":2}]', '{"__proto__":1,"__proto__":2}']) {
    assert.throws(() => parseStrictJson(input), /DUPLICATE_JSON_KEY/);
  }
});
test('valid JSON matches native parser with distinct object scopes', () => {
  for (const input of ['{"x":[{"x":1},{"x":2}]}', '{"emoji":"\\ud83d\\ude00","한글":true}', '[-1.5e+2,null,false,"escape\\\\quote\\\""]', '{"__proto__":{"x":1}}']) {
    assert.deepEqual(parseStrictJson(input), JSON.parse(input));
  }
});
test('malformed and excessively deep input rejected', () => {
  for (const input of ['{"x":1,}', '{"x":NaN}', '01', '{} {}', '"\\x00"', '']) assert.throws(() => parseStrictJson(input));
  assert.throws(() => parseStrictJson('['.repeat(66)+'0'+']'.repeat(66)), /JSON_DEPTH_LIMIT/);
});
test('unpaired surrogates rejected before private verifier transport', () => {
  for (const input of ['{"x":"\\ud800"}', '{"\\udc00":1}', '"\\ud800x"']) assert.throws(() => parseStrictJson(input), /INVALID_JSON_UNICODE/);
});
test('MemoryDB contract preparation opens no connection and rejects untrusted endpoints', async () => {
  assert.throws(() => createMemoryDbReplayStore({host:'127.0.0.1',username:'fixture',password:'fixture'}), /CONFIGURATION_REQUIRED/);
  const store = createMemoryDbReplayStore({host:'nonexistent-fixture.memorydb.amazonaws.com',username:'fixture',password:'fixture'});
  try {
    await assert.rejects(store.claim({domain:'00'.repeat(32),context:'00'.repeat(16),nonce:'00'.repeat(16),ttlMs:3000}), /NOT_CONNECTED/);
    await assert.rejects(store.claim({domain:'00'.repeat(32),context:'00'.repeat(16),nonce:'00'.repeat(16),ttlMs:0}), /INVALID_REPLAY_CLAIM/);
  } finally { store.close(); }
});
