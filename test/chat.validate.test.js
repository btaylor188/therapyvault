// Validates the LLM-proxy payload guard shared by /chat, /summarize, /memorize.
// No DB or network needed (the pg pool is created lazily and never connects).
// Run: node test/chat.validate.test.js
import assert from 'node:assert/strict';
import { validate, validatePrefs } from '../server/routes/chat.js';
import { THERAPY_STYLES } from '../server/llm.js';

let passed = 0;
const ok = (name) => { console.log('  ok -', name); passed++; };

// valid payload
assert.equal(validate([{ role: 'user', content: 'hi' }]), null);
assert.equal(
  validate([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'system', content: 'c' },
  ]),
  null
);
ok('accepts well-formed messages');

// shape errors
assert.ok(validate(undefined));
assert.ok(validate([]));
assert.ok(validate('nope'));
ok('rejects missing/empty/non-array messages');

// bad roles / bad content
assert.ok(validate([{ role: 'tool', content: 'x' }]));
assert.ok(validate([{ role: 'user', content: 42 }]));
assert.ok(validate([{ role: 'user' }]));
assert.ok(validate([null]));
ok('rejects invalid role/content shapes');

// size limits
assert.ok(validate(Array.from({ length: 401 }, () => ({ role: 'user', content: 'x' }))));
assert.ok(validate([{ role: 'user', content: 'x'.repeat(400_001) }]));
assert.equal(validate([{ role: 'user', content: 'x'.repeat(1000) }]), null);
ok('enforces message-count and char limits');

// style / custom-prompt guard (proxy mode)
assert.equal(validatePrefs(undefined, undefined), null);
assert.equal(validatePrefs(null, null), null);
for (const s of THERAPY_STYLES) assert.equal(validatePrefs(s.id, undefined), null);
assert.equal(validatePrefs('cbt', 'be extra gentle with me'), null);
ok('accepts known styles and short custom prompts');

assert.ok(validatePrefs('hypnosis', undefined)); // unknown style id
assert.ok(validatePrefs(42, undefined));
assert.ok(validatePrefs(undefined, 12345));
assert.ok(validatePrefs(undefined, 'x'.repeat(4001))); // custom too long
assert.equal(validatePrefs(undefined, 'x'.repeat(4000)), null);
ok('rejects unknown styles and oversized/non-string custom prompts');

// every style is well-formed (id/label/description present, prompt is a string)
for (const s of THERAPY_STYLES) {
  assert.ok(s.id && s.label && typeof s.description === 'string' && typeof s.prompt === 'string');
}
assert.ok(THERAPY_STYLES.some((s) => s.id === 'integrative'));
ok('style catalog is well-formed and includes the default');

console.log(`\nPASS: ${passed}/7 validation groups hold`);
