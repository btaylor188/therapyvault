// Per-user preferences (therapy style + custom instructions). One encrypted
// blob per user, same zero-knowledge posture as memories: the server stores
// and returns ciphertext only. In direct mode even the chosen style never
// reaches the server in plaintext; in proxy mode it is sent per-request like
// message plaintext (transient, never persisted).
import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

// Fetch the encrypted prefs blob (or {exists:false}).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT body_enc, updated_at FROM prefs WHERE user_id=$1`,
      [req.session.user.id]
    );
    if (!rows.length) return res.json({ exists: false });
    res.json({ exists: true, ...rows[0] });
  } catch (e) {
    next(e);
  }
});

// Upsert the encrypted prefs blob.
router.put('/', async (req, res, next) => {
  try {
    const { body_enc } = req.body || {};
    if (!body_enc || typeof body_enc !== 'string') {
      return res.status(400).json({ error: 'missing fields' });
    }
    await q(
      `INSERT INTO prefs (user_id, body_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET body_enc=EXCLUDED.body_enc, updated_at=now()`,
      [req.session.user.id, body_enc]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Reset to defaults.
router.delete('/', async (req, res, next) => {
  try {
    await q(`DELETE FROM prefs WHERE user_id=$1`, [req.session.user.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
