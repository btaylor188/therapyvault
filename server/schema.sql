-- Zero-knowledge-at-rest schema.
-- The server stores ONLY ciphertext and non-sensitive metadata.
-- It never stores: vault password, KEK, DEK, or any message plaintext.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- generated uuid (local auth) or Entra oid
  email         TEXT NOT NULL,             -- email, for allowlist + display
  pw_hash       TEXT,                      -- local-auth password (scrypt); NULL under Entra
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent for DBs created before local auth existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pw_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- One vault per user. Envelope-encryption material only.
-- kdf_salt  : Argon2id salt (base64)  -> browser derives KEK from vault password
-- wrapped_dek: AES-GCM(KEK, DEK) as base64 "iv:ciphertext"
-- verifier  : AES-GCM(KEK, known-constant) as base64 "iv:ciphertext"
--             Used to detect a wrong vault password (GCM tag fails to verify).
-- kdf_params: JSON of Argon2id params actually used (for future re-tuning).
CREATE TABLE IF NOT EXISTS vaults (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf_salt      TEXT NOT NULL,
  kdf_params    JSONB NOT NULL,
  wrapped_dek   TEXT NOT NULL,
  verifier      TEXT NOT NULL,
  -- Direct mode: the user's Anthropic API key, AES-GCM(DEK, key). The browser
  -- calls the LLM directly; the server can never read this. Survives password
  -- rotation unchanged (it is wrapped by the DEK, not the KEK).
  api_key_enc   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent for DBs created before direct mode existed.
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS api_key_enc TEXT;

-- Prior vault wrappings, archived on every password rotation. Rotation re-wraps
-- the SAME DEK, so any history row + its (old) vault password can still recover
-- the DEK. This makes a hijacked-session vault overwrite recoverable instead of
-- permanent data destruction. Ciphertext only — zero-knowledge is unaffected.
CREATE TABLE IF NOT EXISTS vault_history (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kdf_salt      TEXT NOT NULL,
  kdf_params    JSONB NOT NULL,
  wrapped_dek   TEXT NOT NULL,
  verifier      TEXT NOT NULL,
  replaced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vault_history_user ON vault_history(user_id, replaced_at DESC);

-- Long-term memory: one rolling "case file" per user, encrypted client-side
-- (AES-GCM(DEK, plaintext) as "iv:ciphertext"). Injected into the system
-- prompt alongside per-conversation summaries. Never stored as plaintext.
CREATE TABLE IF NOT EXISTS memories (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_enc      TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user preferences: therapy style + custom instructions, as one encrypted
-- JSON blob (AES-GCM(DEK, json) as "iv:ciphertext"). Never stored as plaintext.
CREATE TABLE IF NOT EXISTS prefs (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_enc      TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Title is encrypted client-side too (AES-GCM(DEK, title)).
  title_enc     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- Messages and rolling summaries. Body is always ciphertext.
-- kind: 'message'  = a verbatim turn
--       'summary'  = a compacted summary replacing archived turns
-- role: 'user' | 'assistant' | 'system'
-- archived: TRUE once folded into a summary (kept for audit/undo, not sent to LLM)
CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'message',
  role          TEXT NOT NULL,
  body_enc      TEXT NOT NULL,             -- AES-GCM(DEK, plaintext) as "iv:ciphertext"
  token_est     INTEGER NOT NULL DEFAULT 0,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

-- Session store (connect-pg-simple) is created by that library automatically.
