// Conversation + message storage. Bodies are always ciphertext (AES-GCM(DEK, ...)).
// Every query is scoped to the authenticated user; there is no cross-user read path,
// and no endpoint that returns another user's rows.
import { Router } from 'express';
import { pool, q } from '../db.js';
import { requireAuth } from '../auth.js';

const router = Router();
router.use(requireAuth);

const uid = (req) => req.session.user.id;

// List conversations (metadata + encrypted title).
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT id, title_enc, created_at, updated_at
         FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC`,
      [uid(req)]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Create a conversation.
router.post('/', async (req, res, next) => {
  try {
    const { title_enc } = req.body || {};
    const { rows } = await q(
      `INSERT INTO conversations (user_id, title_enc) VALUES ($1, $2)
       RETURNING id, title_enc, created_at, updated_at`,
      [uid(req), title_enc || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// Rename (encrypted title).
router.patch('/:id', async (req, res, next) => {
  try {
    const { title_enc } = req.body || {};
    const { rowCount } = await q(
      `UPDATE conversations SET title_enc=$3, updated_at=now()
        WHERE id=$1 AND user_id=$2`,
      [req.params.id, uid(req), title_enc || null]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await q(
      `DELETE FROM conversations WHERE id=$1 AND user_id=$2`,
      [req.params.id, uid(req)]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

async function ownsConversation(conversationId, userId) {
  const { rows } = await q(
    `SELECT 1 FROM conversations WHERE id=$1 AND user_id=$2`,
    [conversationId, userId]
  );
  return rows.length > 0;
}

// Load active (non-archived) messages + summaries, in order.
router.get('/:id/messages', async (req, res, next) => {
  try {
    if (!(await ownsConversation(req.params.id, uid(req)))) {
      return res.status(404).json({ error: 'not found' });
    }
    const { rows } = await q(
      `SELECT id, kind, role, body_enc, token_est, archived, created_at
         FROM messages
        WHERE conversation_id=$1 AND archived=FALSE
        ORDER BY id ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Append a message (ciphertext).
router.post('/:id/messages', async (req, res, next) => {
  try {
    if (!(await ownsConversation(req.params.id, uid(req)))) {
      return res.status(404).json({ error: 'not found' });
    }
    const { role, body_enc, token_est, kind } = req.body || {};
    if (!role || !body_enc) return res.status(400).json({ error: 'missing fields' });
    const { rows } = await q(
      `INSERT INTO messages (conversation_id, user_id, kind, role, body_enc, token_est)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, kind, role, body_enc, token_est, archived, created_at`,
      [req.params.id, uid(req), kind || 'message', role, body_enc, token_est || 0]
    );
    await q(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [req.params.id]);
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// Compaction commit: atomically insert a summary and archive folded turns.
// body: { summary: {role, body_enc, token_est}, archive_ids: [id,...] }
router.post('/:id/compact', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!(await ownsConversation(req.params.id, uid(req)))) {
      client.release();
      return res.status(404).json({ error: 'not found' });
    }
    const { summary, archive_ids } = req.body || {};
    if (!summary?.body_enc || !Array.isArray(archive_ids)) {
      client.release();
      return res.status(400).json({ error: 'missing fields' });
    }
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO messages (conversation_id, user_id, kind, role, body_enc, token_est)
       VALUES ($1, $2, 'summary', $3, $4, $5)
       RETURNING id, kind, role, body_enc, token_est, archived, created_at`,
      [req.params.id, uid(req), summary.role || 'system', summary.body_enc, summary.token_est || 0]
    );
    if (archive_ids.length) {
      await client.query(
        `UPDATE messages SET archived=TRUE
          WHERE conversation_id=$1 AND user_id=$2 AND id = ANY($3::bigint[])`,
        [req.params.id, uid(req), archive_ids]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, summary: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally {
    client.release();
  }
});

export default router;
