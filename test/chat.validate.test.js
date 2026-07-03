// Validates the LLM-proxy payload guard shared by /chat, /summarize, /memorize.
// No DB or network needed (the pg pool is created lazily and never connects).
// Run: node test/chat.validate.test.js
import assert from 'node:assert/strict';
import { validate } from '../server/routes/chat.js';

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

console.log(`\nPASS: ${passed}/4 validation groups hold`);
