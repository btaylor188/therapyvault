// Long-term memory ("case file") storage. One rolling blob per user, encrypted
// client-side with the DEK. The server stores and returns ciphertext only —
// same zero-knowledge posture as messages. Summarization happens in the
// browser (direct Anthropic call with the user's own key), never here.
import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

// Fetch the encrypted case file (or {exists:false}).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT body_enc, updated_at FROM memories WHERE user_id=$1`,
      [req.session.user.id]
    );
    if (!rows.length) return res.json({ exists: false });
    res.json({ exists: true, ...rows[0] });
  } catch (e) {
    next(e);
  }
});

// Upsert the encrypted case file.
router.put('/', async (req, res, next) => {
  try {
    const { body_enc } = req.body || {};
    if (!body_enc || typeof body_enc !== 'string') {
      return res.status(400).json({ error: 'missing fields' });
    }
    await q(
      `INSERT INTO memories (user_id, body_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET body_enc=EXCLUDED.body_enc, updated_at=now()`,
      [req.session.user.id, body_enc]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Delete the case file (user-initiated forget).
router.delete('/', async (req, res, next) => {
  try {
    await q(`DELETE FROM memories WHERE user_id=$1`, [req.session.user.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
