// LLM proxy. This is the ONLY place plaintext exists server-side, and only
// transiently in-request. Nothing here is written to the DB or logs.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  streamChat,
  complete,
  DEFAULT_SYSTEM,
  SUMMARIZE_SYSTEM,
  MEMORIZE_SYSTEM,
} from '../llm.js';

const router = Router();
router.use(requireAuth);

// LLM access mode:
//  - 'direct': the browser calls Anthropic itself with the user's own key
//    (stored DEK-encrypted in the vault). Plaintext NEVER touches this server.
//  - 'proxy':  legacy path through /chat, /summarize, /memorize below.
// Default: direct unless a server-side LLM_API_KEY is configured.
const MODE = (process.env.LLM_MODE || (process.env.LLM_API_KEY ? 'proxy' : 'direct')).toLowerCase();

// Non-secret client config (mode, model, compaction tuning, shared prompts).
router.get('/config', (req, res) => {
  res.json({
    compactTokenThreshold: Number(process.env.COMPACT_TOKEN_THRESHOLD || 8000),
    compactKeepRecent: Number(process.env.COMPACT_KEEP_RECENT || 8),
    provider: process.env.LLM_PROVIDER || 'anthropic',
    mode: MODE,
    model: process.env.LLM_MODEL || 'claude-sonnet-5',
    prompts: {
      system: DEFAULT_SYSTEM,
      summarize: SUMMARIZE_SYSTEM,
      memorize: MEMORIZE_SYSTEM,
    },
  });
});

// Basic sanity limits to avoid abusive payloads.
const MAX_MESSAGES = 400;
const MAX_CHARS = 400_000;
const MAX_MEMO_CHARS = 20_000;

export function validate(messages) {
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
    const { messages, memo, memory } = req.body || {};
    const err = validate(messages);
    if (err) return res.status(400).json({ error: err });
    if ((memo && memo.length > MAX_MEMO_CHARS) || (memory && memory.length > MAX_MEMO_CHARS)) {
      return res.status(400).json({ error: 'memo too large' });
    }

    // Continuity material (decrypted client-side, appended to the system
    // prompt, never stored):
    //  - memory: long-term case file spanning all prior sessions
    //  - memo:   summary of earlier turns in THIS session (compaction)
    let system;
    if (memory || memo) {
      system = DEFAULT_SYSTEM;
      if (memory) system += `\n\n# Continuity notes — long-term case file (all prior sessions)\n${memory}`;
      if (memo) system += `\n\n# Continuity notes — earlier in this session (summarized)\n${memo}`;
    }

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

    const text = await complete({
      system: SUMMARIZE_SYSTEM,
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

// Memory helper: merge the existing case file with recent turns into an
// updated long-term case file. Returns plaintext; the browser encrypts it
// before storing (PUT /api/memory). Nothing is persisted or logged here.
router.post('/memorize', async (req, res, next) => {
  try {
    const { memory, messages } = req.body || {};
    const err = validate(messages);
    if (err) return res.status(400).json({ error: err });
    if (memory && (typeof memory !== 'string' || memory.length > MAX_MEMO_CHARS)) {
      return res.status(400).json({ error: 'invalid memory' });
    }

    const text = await complete({
      system: MEMORIZE_SYSTEM,
      messages: [
        ...(memory
          ? [{ role: 'user', content: `[Existing case file]\n${memory}` }]
          : []),
        ...messages,
        { role: 'user', content: 'Produce the updated case file now.' },
      ],
      temperature: 0.2,
    });
    res.json({ memory: text });
  } catch (e) {
    next(e);
  }
});

export default router;
