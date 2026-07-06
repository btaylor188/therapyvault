// Sanity checks on the prompt/style catalog served to the browser via
// /api/config. No DB or network needed.
// Run: node test/prompts.test.js
import assert from 'node:assert/strict';
import {
  DEFAULT_SYSTEM,
  SUMMARIZE_SYSTEM,
  MEMORIZE_SYSTEM,
  THERAPY_STYLES,
} from '../server/prompts.js';

let passed = 0;
const ok = (name) => { console.log('  ok -', name); passed++; };

// core prompts exist and are substantial
for (const [name, p] of [
  ['DEFAULT_SYSTEM', DEFAULT_SYSTEM],
  ['SUMMARIZE_SYSTEM', SUMMARIZE_SYSTEM],
  ['MEMORIZE_SYSTEM', MEMORIZE_SYSTEM],
]) {
  assert.ok(typeof p === 'string' && p.length > 100, `${name} missing or too short`);
}
assert.ok(DEFAULT_SYSTEM.includes('988'), 'crisis guidance missing from DEFAULT_SYSTEM');
ok('core prompts are present (incl. crisis guidance)');

// every style is well-formed (id/label/description present, prompt is a string)
assert.ok(Array.isArray(THERAPY_STYLES) && THERAPY_STYLES.length >= 2);
for (const s of THERAPY_STYLES) {
  assert.ok(s.id && s.label && typeof s.description === 'string' && typeof s.prompt === 'string');
}
ok('style catalog is well-formed');

// unique ids; the default 'integrative' exists and adds no addendum
const ids = THERAPY_STYLES.map((s) => s.id);
assert.equal(new Set(ids).size, ids.length, 'duplicate style ids');
const def = THERAPY_STYLES.find((s) => s.id === 'integrative');
assert.ok(def, "missing default 'integrative' style");
assert.equal(def.prompt, '', 'integrative must add no prompt addendum');
for (const s of THERAPY_STYLES) {
  if (s.id !== 'integrative') assert.ok(s.prompt.length > 50, `${s.id} prompt too short`);
}
ok('ids unique; integrative default is a no-op, others carry real prompts');

console.log(`\nPASS: ${passed}/3 prompt-catalog groups hold`);
