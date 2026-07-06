// Validates the envelope-encryption scheme end to end in Node:
//  - correct password unlocks the DEK and round-trips a message
//  - WRONG password fails to unlock (GCM auth tag rejects) -> zero-knowledge holds
//  - password rotation re-wraps the SAME DEK so old ciphertext stays readable
//  - the DEK key handle is non-extractable (rotation works from raw bytes)
//
// Run: node test/crypto.roundtrip.test.js
import { argon2id } from 'hash-wasm';
import { webcrypto as crypto } from 'node:crypto';
import assert from 'node:assert/strict';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PARAMS = { memorySize: 8192, iterations: 2, parallelism: 1, hashLength: 32 };
const VERIFIER_CONST = 'vault-ok-v1';

const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKEK(password, salt) {
  const raw = await argon2id({ password, salt, ...PARAMS, outputType: 'binary' });
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function gcmEnc(key, bytes) {
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return `${b64(iv)}:${b64(new Uint8Array(ct))}`;
}
async function gcmDec(key, blob) {
  const [iv, ct] = blob.split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return new Uint8Array(pt);
}
// Mirrors public/crypto.js: the DEK handle is never extractable.
const importDEK = (raw) =>
  crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

async function createVault(password) {
  const salt = rnd(16);
  const kek = await deriveKEK(password, salt);
  const dekRaw = rnd(32);
  return {
    salt: b64(salt),
    wrapped_dek: await gcmEnc(kek, dekRaw),
    verifier: await gcmEnc(kek, enc.encode(VERIFIER_CONST)),
  };
}
async function unlock(password, vault) {
  const kek = await deriveKEK(password, unb64(vault.salt));
  const v = dec.decode(await gcmDec(kek, vault.verifier)); // throws on wrong pw
  assert.equal(v, VERIFIER_CONST);
  return importDEK(await gcmDec(kek, vault.wrapped_dek));
}

let passed = 0;
const ok = (name) => { console.log('  ok -', name); passed++; };

(async () => {
  const PW = 'correct horse battery staple';
  const vault = await createVault(PW);

  // 1) round-trip a message under the correct password
  const dek = await unlock(PW, vault);
  const secret = 'I felt anxious about the conversation last night.';
  const blob = await gcmEnc(dek, enc.encode(secret));
  assert.equal(dec.decode(await gcmDec(dek, blob)), secret);
  ok('correct password round-trips a message');

  // 2) wrong password cannot unlock (zero-knowledge property)
  await assert.rejects(() => unlock('wrong password', vault));
  ok('wrong password is rejected (cannot derive DEK)');

  // 3) server-side data is opaque: verifier/wrapped_dek reveal nothing without pw
  assert.ok(!vault.wrapped_dek.includes(secret));
  assert.ok(vault.wrapped_dek.includes(':') && vault.verifier.includes(':'));
  ok('stored vault material is ciphertext only');

  // 4) password rotation preserves the DEK -> old ciphertext still decrypts.
  // Like public/crypto.js, rotation unwraps the raw bytes with the old KEK —
  // it cannot export them from the (non-extractable) key handle.
  const oldKek = await deriveKEK(PW, unb64(vault.salt));
  const dekRaw = await gcmDec(oldKek, vault.wrapped_dek);
  const newSalt = rnd(16);
  const newKek = await deriveKEK('a brand new passphrase', newSalt);
  const rotated = {
    salt: b64(newSalt),
    wrapped_dek: await gcmEnc(newKek, dekRaw),
    verifier: await gcmEnc(newKek, enc.encode(VERIFIER_CONST)),
  };
  const dek2 = await unlock('a brand new passphrase', rotated);
  assert.equal(dec.decode(await gcmDec(dek2, blob)), secret);
  ok('password rotation keeps old ciphertext readable');

  // 5) the unlocked DEK handle cannot leak raw key material
  assert.equal(dek.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('raw', dek));
  ok('DEK handle is non-extractable (script with the handle cannot export the key)');

  console.log(`\nPASS: ${passed}/5 crypto invariants hold`);
})().catch((e) => {
  console.error('\nFAIL:', e);
  process.exit(1);
});
