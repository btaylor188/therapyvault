// Vault (envelope-encryption material) endpoints.
// The server stores and returns only ciphertext + KDF params. None of this is
// usable without the vault password, which never leaves the browser.
import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

// Fetch vault material (or {exists:false} for first-time setup).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT kdf_salt, kdf_params, wrapped_dek, verifier FROM vaults WHERE user_id = $1`,
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
router.put('/', async (req, res, next) => {
  try {
    const { kdf_salt, kdf_params, wrapped_dek, verifier } = req.body || {};
    if (!kdf_salt || !kdf_params || !wrapped_dek || !verifier) {
      return res.status(400).json({ error: 'missing fields' });
    }
    const { rowCount } = await q(
      `UPDATE vaults
         SET kdf_salt=$2, kdf_params=$3, wrapped_dek=$4, verifier=$5, updated_at=now()
       WHERE user_id=$1`,
      [req.session.user.id, kdf_salt, kdf_params, wrapped_dek, verifier]
    );
    if (!rowCount) return res.status(404).json({ error: 'no vault' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
