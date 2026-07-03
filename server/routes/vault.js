// Vault (envelope-encryption material) endpoints.
// The server stores and returns only ciphertext + KDF params. None of this is
// usable without the vault password, which never leaves the browser.
import { Router } from 'express';
import { pool, q } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

// Fetch vault material (or {exists:false} for first-time setup).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT kdf_salt, kdf_params, wrapped_dek, verifier, api_key_enc
         FROM vaults WHERE user_id = $1`,
      [req.session.user.id]
    );
    if (!rows.length) return res.json({ exists: false });
    res.json({ exists: true, ...rows[0] });
  } catch (e) {
    next(e);
  }
});

// Create vault (first-time setup). Fails if one already exists.
router.post('/', async (req, res, next) => {
  try {
    const { kdf_salt, kdf_params, wrapped_dek, verifier } = req.body || {};
    if (!kdf_salt || !kdf_params || !wrapped_dek || !verifier) {
      return res.status(400).json({ error: 'missing fields' });
    }
    await q(
      `INSERT INTO vaults (user_id, kdf_salt, kdf_params, wrapped_dek, verifier)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.session.user.id, kdf_salt, kdf_params, wrapped_dek, verifier]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'vault exists' });
    next(e);
  }
});

// Rotate vault password: re-wrap the SAME DEK under a new KEK.
// Data stays readable; only the wrapping changes. Done entirely client-side;
// server just stores the new blobs.
//
// The previous wrapping is archived to vault_history first (same transaction).
// The server cannot verify the old vault password (zero-knowledge), so any
// authenticated session could otherwise overwrite wrapped_dek and permanently
// destroy history. With history, the old row + old password still recovers the
// DEK — overwrite becomes recoverable, not destructive.
router.put('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { kdf_salt, kdf_params, wrapped_dek, verifier } = req.body || {};
    if (!kdf_salt || !kdf_params || !wrapped_dek || !verifier) {
      return res.status(400).json({ error: 'missing fields' });
    }
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO vault_history (user_id, kdf_salt, kdf_params, wrapped_dek, verifier)
       SELECT user_id, kdf_salt, kdf_params, wrapped_dek, verifier
         FROM vaults WHERE user_id=$1`,
      [req.session.user.id]
    );
    const { rowCount } = await client.query(
      `UPDATE vaults
         SET kdf_salt=$2, kdf_params=$3, wrapped_dek=$4, verifier=$5, updated_at=now()
       WHERE user_id=$1`,
      [req.session.user.id, kdf_salt, kdf_params, wrapped_dek, verifier]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'no vault' });
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

// Store/replace/clear the user's LLM API key, encrypted client-side under the
// DEK (direct mode). Ciphertext only — the server cannot use or read the key.
router.put('/api-key', async (req, res, next) => {
  try {
    const { api_key_enc } = req.body || {}; // null/undefined clears the key
    if (api_key_enc !== undefined && api_key_enc !== null && typeof api_key_enc !== 'string') {
      return res.status(400).json({ error: 'invalid field' });
    }
    const { rowCount } = await q(
      `UPDATE vaults SET api_key_enc=$2, updated_at=now() WHERE user_id=$1`,
      [req.session.user.id, api_key_enc || null]
    );
    if (!rowCount) return res.status(404).json({ error: 'no vault' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
