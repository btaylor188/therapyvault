// Client-side envelope encryption. Nothing here ever sends the vault password,
// the KEK, or the DEK to the server. Only ciphertext + KDF params leave the browser.
//
// Key hierarchy:
//   vault password --Argon2id(salt)--> KEK (AES-GCM)
//   random 256-bit DEK, wrapped as AES-GCM(KEK, DEK) -> stored server-side
//   messages/titles/summaries = AES-GCM(DEK, plaintext)

const enc = new TextEncoder();
const dec = new TextDecoder();

// hash-wasm UMD exposes `hashwasm` on window (loaded via <script> in index.html).
const argon2id = () => window.hashwasm.argon2id;

export const ARGON2_PARAMS = {
  alg: 'argon2id',
  // 64 MiB, 3 passes, single lane. Tune up on capable hardware.
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

// ---- byte / base64 helpers ----
export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
export function b64(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}
export function unb64(str) {
  const s = atob(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

// ---- KEK derivation ----
export async function deriveKEK(password, saltBytes, params = ARGON2_PARAMS) {
  const raw = await argon2id()({
    password,
    salt: saltBytes,
    memorySize: params.memorySize,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: params.hashLength,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---- AES-GCM primitives; wire format is base64("iv:ciphertext") ----
async function gcmEncrypt(key, bytes) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return `${b64(iv)}:${b64(ct)}`;
}
async function gcmDecrypt(key, blob) {
  const [ivB64, ctB64] = blob.split(':');
  const iv = unb64(ivB64);
  const ct = unb64(ctB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

const VERIFIER_CONST = 'vault-ok-v1';

// ---- Vault lifecycle ----

// Create fresh vault material for a brand-new user.
export async function createVaultMaterial(password) {
  const salt = randomBytes(16);
  const kek = await deriveKEK(password, salt);
  const dekRaw = randomBytes(32);
  const wrapped = await gcmEncrypt(kek, dekRaw);
  const verifier = await gcmEncrypt(kek, enc.encode(VERIFIER_CONST));
  const dekKey = await importDEK(dekRaw);
  return {
    material: {
      kdf_salt: b64(salt),
      kdf_params: ARGON2_PARAMS,
      wrapped_dek: wrapped,
      verifier,
    },
    dekKey,
  };
}

// Unwrap the raw DEK bytes with the password-derived KEK. Internal only:
// the raw bytes exist transiently for (re)wrapping and are never attached to
// an extractable key handle. Throws 'BAD_PASSWORD' if the password is wrong.
async function unwrapDEK(password, vault) {
  const salt = unb64(vault.kdf_salt);
  const params = vault.kdf_params || ARGON2_PARAMS;
  const kek = await deriveKEK(password, salt, params);
  try {
    const v = dec.decode(await gcmDecrypt(kek, vault.verifier));
    if (v !== VERIFIER_CONST) throw new Error('mismatch');
  } catch {
    const e = new Error('BAD_PASSWORD');
    e.code = 'BAD_PASSWORD';
    throw e;
  }
  return gcmDecrypt(kek, vault.wrapped_dek);
}

// Unlock an existing vault. Throws 'BAD_PASSWORD' if the password is wrong.
export async function unlockVault(password, vault) {
  return importDEK(await unwrapDEK(password, vault));
}

// Rotate the vault password: re-wrap the SAME DEK under a new KEK. Works from
// the freshly unwrapped raw bytes, never from a key handle.
export async function rotatePassword(oldPassword, newPassword, vault) {
  const dekRaw = await unwrapDEK(oldPassword, vault); // verifies old password
  const salt = randomBytes(16);
  const kek = await deriveKEK(newPassword, salt);
  const wrapped = await gcmEncrypt(kek, dekRaw);
  const verifier = await gcmEncrypt(kek, enc.encode(VERIFIER_CONST));
  return {
    kdf_salt: b64(salt),
    kdf_params: ARGON2_PARAMS,
    wrapped_dek: wrapped,
    verifier,
  };
}

// The DEK handle is NOT extractable: script that gets hold of it (e.g. via
// XSS) can decrypt only while the page is open — it can never export the raw
// key for offline use against a stolen DB. Rotation re-wraps from unwrapDEK's
// raw bytes, so nothing ever needs to export this handle.
function importDEK(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---- message helpers ----
export async function encStr(dekKey, str) {
  return gcmEncrypt(dekKey, enc.encode(str));
}
export async function decStr(dekKey, blob) {
  return dec.decode(await gcmDecrypt(dekKey, blob));
}
