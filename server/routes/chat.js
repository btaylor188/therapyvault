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
  THERAPY_STYLES,
} from '../llm.js';

const router = Router();
router.use(requireAuth);

// LLM access mode:
//  - 'direct': the browser calls Anthropic itself with the user's own key
//    (stored DEK-encrypted in the vault). Plaintext NEVER touches this server.
//  - 'proxy':  legacy path through /chat, /summarize, /memorize below.
// Default: direct unless a server-side LLM_API_KEY is configured.
const MODE = (process.env.LLM_MODE || (process.env.LLM_API_KEY ? 'proxy' : 'direct')).toLowerCase();

// Utility model: cheaper model for background tasks (compaction summaries,
// memory/case-file updates). Chat stays on LLM_MODEL. Falls back to LLM_MODEL.
const MAIN_MODEL = process.env.LLM_MODEL || 'claude-sonnet-5';
const UTILITY_MODEL = process.env.LLM_MODEL_UTILITY || MAIN_MODEL;

// Non-secret client config (mode, model, compaction tuning, shared prompts).
router.get('/config', (req, res) => {
  res.json({
    compactTokenThreshold: Number(process.env.COMPACT_TOKEN_THRESHOLD || 8000),
    compactKeepRecent: Number(process.env.COMPACT_KEEP_RECENT || 8),
    provider: process.env.LLM_PROVIDER || 'anthropic',
    mode: MODE,
    model: MAIN_MODEL,
    utilityModel: UTILITY_MODEL,
    prompts: {
      system: DEFAULT_SYSTEM,
      summarize: SUMMARIZE_SYSTEM,
      memorize: MEMORIZE_SYSTEM,
    },
    styles: THERAPY_STYLES,
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

// Proxy-mode style/custom-prompt guard. Both are optional; style must be a
// known id and custom instructions are length-capped.
const STYLE_IDS = new Set(THERAPY_STYLES.map((s) => s.id));
const MAX_CUSTOM_CHARS = 4000;

export function validatePrefs(style, custom) {
  if (style != null && (typeof style !== 'string' || !STYLE_IDS.has(style))) {
    return 'invalid style';
  }
  if (custom != null && (typeof custom !== 'string' || custom.length > MAX_CUSTOM_CHARS)) {
    return 'invalid custom prompt';
  }
  return null;
}

// Streaming chat: text/event-stream of {delta} then {done}.
router.post('/chat', async (req, res, next) => {
  try {
    const { messages, memo, memory, style, custom } = req.body || {};
    const err = validate(messages);
    if (err) return res.status(400).json({ error: err });
    if ((memo && memo.length > MAX_MEMO_CHARS) || (memory && memory.length > MAX_MEMO_CHARS)) {
      return res.status(400).json({ error: 'memo too large' });
    }
    const perr = validatePrefs(style, custom);
    if (perr) return res.status(400).json({ error: perr });

    // System-prompt extras (all decrypted client-side, appended in-request,
    // never stored):
    //  - style:  id of the therapy style the user picked (prompt looked up here)
    //  - custom: the user's own extra instructions
    //  - memory: long-term case file spanning all prior sessions
    //  - memo:   summary of earlier turns in THIS session (compaction)
    const styleDef = style ? THERAPY_STYLES.find((s) => s.id === style) : null;
    let system;
    if (memory || memo || styleDef?.prompt || custom) {
      system = DEFAULT_SYSTEM;
      if (styleDef?.prompt) system += `\n\n# Therapeutic approach chosen by the user\n${styleDef.prompt}`;
      if (custom) system += `\n\n# Custom instructions from the user\n${custom}`;
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
      model: UTILITY_MODEL,
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
      model: UTILITY_MODEL,
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
