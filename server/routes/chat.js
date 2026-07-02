// LLM proxy. This is the ONLY place plaintext exists server-side, and only
// transiently in-request. Nothing here is written to the DB or logs.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { streamChat, complete, DEFAULT_SYSTEM } from '../llm.js';

const router = Router();
router.use(requireAuth);

// Non-secret client config (compaction tuning + provider label).
router.get('/config', (req, res) => {
  res.json({
    compactTokenThreshold: Number(process.env.COMPACT_TOKEN_THRESHOLD || 8000),
    compactKeepRecent: Number(process.env.COMPACT_KEEP_RECENT || 8),
    provider: process.env.LLM_PROVIDER || 'anthropic',
  });
});

// Basic sanity limits to avoid abusive payloads.
const MAX_MESSAGES = 400;
const MAX_CHARS = 400_000;

function validate(messages) {
  if (!Array.isArray(messages) || !messages.length) return 'messages required';
  if (messages.length > MAX_MESSAGES) return 'too many messages';
  let chars = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== 'string' || !['user', 'assistant', 'system'].includes(m.role)) {
      return 'invalid message';
    }
    chars += m.content.length;
  }
  if (chars > MAX_CHARS) return 'payload too large';
  return null;
}

// Streaming chat: text/event-stream of {delta} then {done}.
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, memo } = req.body || {};
    const err = validate(messages);
    if (err) return res.status(400).json({ error: err });

    // Continuity memo (decrypted client-side summary of older turns) is appended
    // to the default therapy system prompt, not stored.
    const system = memo
      ? `${DEFAULT_SYSTEM}\n\n# Continuity notes (prior sessions)\n${memo}`
      : undefined;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      await streamChat({ messages, system }, (delta) => send({ delta }));
      send({ done: true });
    } catch (e) {
      send({ error: String(e.message || e) });
    }
    res.end();
  } catch (e) {
    next(e);
  }
});

// Compaction helper: summarize old turns into a compact briefing.
// Returns plaintext summary; the browser encrypts it before storing.
router.post('/summarize', async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    const err = validate(messages);
    if (err) return res.status(400).json({ error: err });

    const system =
      'You compress a therapy conversation into a concise clinical-style memo for ' +
      'continuity. Preserve: the client\'s presenting concerns, key facts about their ' +
      'life and relationships, emotional themes, goals, coping strategies discussed, ' +
      'and any commitments or homework. Omit small talk. Write in third person, ' +
      'under 300 words. Output only the memo.';

    const text = await complete({
      system,
      messages: [
        ...messages,
        { role: 'user', content: 'Produce the continuity memo now.' },
      ],
      temperature: 0.2,
    });
    res.json({ summary: text });
  } catch (e) {
    next(e);
  }
});

export default router;
