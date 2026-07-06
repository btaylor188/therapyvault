// Non-secret client config: model names, compaction tuning, and the shared
// prompt/style catalog. All LLM traffic goes browser -> Anthropic with the
// user's own key (stored DEK-encrypted in the vault) — plaintext never
// touches this server and there is no server-side LLM transport.
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import {
  DEFAULT_SYSTEM,
  SUMMARIZE_SYSTEM,
  MEMORIZE_SYSTEM,
  THERAPY_STYLES,
} from '../prompts.js';

const router = Router();
router.use(requireAuth);

// Utility model: cheaper model for background tasks (compaction summaries,
// memory/case-file updates). Chat stays on LLM_MODEL. Falls back to LLM_MODEL.
const MAIN_MODEL = process.env.LLM_MODEL || 'claude-sonnet-5';
const UTILITY_MODEL = process.env.LLM_MODEL_UTILITY || MAIN_MODEL;

router.get('/config', (req, res) => {
  res.json({
    compactTokenThreshold: Number(process.env.COMPACT_TOKEN_THRESHOLD || 8000),
    compactKeepRecent: Number(process.env.COMPACT_KEEP_RECENT || 8),
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

export default router;
