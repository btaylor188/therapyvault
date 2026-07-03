# Vault Therapy

A two-user AI therapy chat with **zero-knowledge-at-rest** storage and
**automatic session compaction**. Runs in Docker.

> **Auth is selectable:** `AUTH_PROVIDER=local` (email+password, the test-build
> default) or `AUTH_PROVIDER=entra` (Entra ID OIDC — see "Switching to Entra").
> No tunnel is bundled — you run your own. The vault / encryption layer is
> identical in both configurations.

Built to a specific privacy contract: as the admin/host you can read the
database and the container, and you will see **only ciphertext**. You cannot read
either user's session history.

---

## What "zero-knowledge at rest" means here (read this)

| Data | Where it lives | Can the admin read it? |
|---|---|---|
| Session history (messages, titles, summaries) | Postgres, `AES-GCM(DEK)` ciphertext | **No** — needs the vault password, which is never sent to the server |
| Long-term memory ("case file") | Postgres, `AES-GCM(DEK)` ciphertext | **No** |
| Anthropic API key (direct mode) | Postgres, `AES-GCM(DEK)` ciphertext | **No** |
| Vault password | Nowhere. Typed in the browser each unlock | **No** |
| Derived key (KEK) / data key (DEK) | Browser memory only, cleared on lock | **No** |
| **Live message being sent to the AI** | Depends on `LLM_MODE` — see below | direct: **No** · proxy: **Yes, in principle** |

Two LLM modes (`LLM_MODE`):

- **`direct` (default, Anthropic only).** The browser calls `api.anthropic.com`
  itself with the user's own API key (stored encrypted in their vault, decrypted
  to browser memory at unlock). **Plaintext never touches the app server** —
  it exists only in the browser and at Anthropic during inference, under their
  API data terms.
- **`proxy` (legacy, supports OpenAI).** The browser sends plaintext over TLS to
  `/api/chat`, which relays it to the provider. It is **never written to the
  database or logs**, but exists in server RAM for the duration of the request.

If you forget the vault password, **the history is permanently unreadable**.
There is no recovery path — that is the point.

### What is *not* hidden (metadata)

The server can see, per user: how many conversations and messages exist, their
timestamps, approximate sizes, and token estimates. It cannot see content. If
message-timing/size metadata is part of your threat model, that needs padding —
noted in Limitations.

---

## Architecture

```
Browser (per user)                     Server (Docker)              External
────────────────────                   ─────────────────            ────────
vault password ─Argon2id(salt)→ KEK
random DEK  ─AES-GCM(KEK)→ wrapped DEK ──POST /api/vault──▶ vaults (ciphertext)
message ─AES-GCM(DEK)→ ciphertext ─────POST /messages────▶ messages (ciphertext)
case file ─AES-GCM(DEK)→ ciphertext ───PUT /api/memory───▶ memories (ciphertext)
API key  ─AES-GCM(DEK)→ ciphertext ────PUT /api/vault/api-key▶ vaults (ciphertext)

direct mode:  decrypt for send ─plaintext(TLS)────────────────────▶ Anthropic
              (server never sees plaintext)                        (streams reply)
proxy mode:   decrypt for send ─plaintext(TLS)─▶ /api/chat ───────▶ Anthropic/OpenAI
                                                 (no persistence)  (streams reply)

sign-in (local scrypt or Entra OIDC) ──▶ /auth/* (identity only)
```

- **Identity ≠ decryption.** Sign-in proves *who you are*; a separate vault
  password unlocks data. Compromising the login account does not reveal history.
- **Envelope encryption.** One random 256-bit DEK per user, wrapped by a
  password-derived KEK (Argon2id, 64 MiB / 3 passes). Changing the vault password
  re-wraps the same DEK, so history stays readable (see "Change vault password").
- **Wrong-password detection** is cryptographic: a verifier blob fails its
  AES-GCM auth tag. No password hash is stored.

## Compaction

Each turn the client estimates context size. Past `COMPACT_TOKEN_THRESHOLD`
tokens it asks the model to fold the oldest turns — plus any previous summary —
into a ~300-word continuity memo, encrypts it, and stores it while marking the
folded turns `archived`. The newest `COMPACT_KEEP_RECENT` turns stay verbatim.
Archived turns remain in the DB (encrypted) but are no longer sent to the
model. The memo is injected into the system prompt on subsequent turns.

## Long-term memory

Alongside per-session compaction, the app keeps one rolling **case file** per
user: durable facts, themes, goals, and commitments across all sessions. It is
refreshed every ~8 messages by the model, stored as ciphertext
(`AES-GCM(DEK)`), and injected into the system prompt of every chat. The
sidebar **Memory** button opens a viewer/editor — you can correct it or erase
it entirely.

Background tasks (compaction + memory updates) run on `LLM_MODEL_UTILITY`
(default `claude-haiku-4-5`, cheaper); chat runs on `LLM_MODEL`.

---

## Setup

> Default is **local email+password auth**; switch to Entra ID with one env var
> (see "Switching to Entra"). No tunnel is bundled — run your own (Cloudflare
> Tunnel, etc.) pointed at `http://localhost:8080`. See "Serving publicly" below.

### 1. Configure

```bash
cp .env.example .env
openssl rand -hex 48        # -> paste into SESSION_SECRET
```

Fill in `ALLOWED_USERS` (the emails allowed to sign in), `POSTGRES_*` +
`DATABASE_URL`, and the `LLM_*` block. In the default `LLM_MODE=direct` no
server-side API key is needed — each user pastes their own Anthropic key into
the app after unlocking (stored encrypted in their vault). For the legacy proxy
mode set `LLM_MODE=proxy` plus `LLM_PROVIDER` and `LLM_API_KEY`. For local
testing leave `NODE_ENV=development` and `BASE_URL=http://localhost:8080`.

### 2. Run

```bash
docker compose up -d --build
```

The app container runs the schema migration (`initdb.js`) then starts on
`127.0.0.1:8080`. Open `http://localhost:8080`.

### 3. First use

1. **Sign in.** Local auth: enter an email from `ALLOWED_USERS` and a password —
   the first sign-in for that email *registers* it. Entra: you're redirected to
   Microsoft. Non-allowlisted accounts are rejected either way.
2. **Set a vault password** (min 10 chars) when prompted. This is separate from
   the login password, never leaves the browser, encrypts all history, and
   cannot be recovered or reset by the admin.
3. **Add your Anthropic API key** (direct mode) when the dialog appears. It is
   encrypted into your vault; the sidebar "API key" button changes or removes it.

Auth here is deliberately minimal — it exists so the two accounts are separated
and the tunnel isn't wide open. The real privacy guarantee is the vault layer,
which is identical to the production design.

### Serving publicly (your own tunnel)

Point your tunnel at `http://localhost:8080`. When it terminates TLS and
forwards `X-Forwarded-Proto: https`, set `NODE_ENV=production` and
`BASE_URL=https://your-host` so the session cookie is marked `Secure`
(`trust proxy` is already enabled). Adding an edge access policy (e.g.
Cloudflare Access limited to your two emails) is recommended as a second gate.

### Switching to Entra

Entra ID is now wired in as a selectable provider — no code changes needed:

1. **Register the app** in Entra: single-tenant Web app, redirect URI
   `https://YOUR_HOST/auth/callback`, create a client secret, delegated
   permissions `openid profile email`.
2. **Set env**: `AUTH_PROVIDER=entra`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`,
   `ENTRA_CLIENT_SECRET`, and `BASE_URL=https://YOUR_HOST`. `ALLOWED_USERS`
   accepts emails and/or object ids (`oid`).
3. **Rebuild**: `docker compose up -d --build` (installs `@azure/msal-node`).

**Do not switch providers on a populated database.** Local auth keys users by
generated UUID; Entra keys them by `oid`. The same email under both providers
means two different user ids — and the vault/history belongs to the old one.
The Entra callback detects this collision and refuses sign-in rather than
splitting data. Either start with a fresh DB or migrate `users.id` to the oid
first (`UPDATE users SET id='<oid>' WHERE email='...'` cascades via FKs — do it
with the app stopped and a backup taken).

Rotate the client secret before it expires; expiry silently breaks sign-in.

---

## Local development

```bash
npm install
npm run check          # syntax-check server
npm run test:crypto    # verify envelope-encryption invariants (4 checks)
```

`docker compose up` is the simplest way to get a working Postgres; the crypto
test runs standalone with no DB.

---

## Security notes & limitations

- **Live plaintext.** In direct mode the app server never sees it; the browser
  and Anthropic do (inherent to hosted inference). If you ever want plaintext to
  never leave your hardware, run proxy mode against a local model (Ollama)
  behind the OpenAI-compatible interface; `llm.js` is provider-agnostic.
- **No plaintext logging.** The error handler returns generic messages; the LLM
  proxy never logs bodies. Keep it that way if you extend it. Also ensure your
  reverse proxy isn't configured to log request bodies.
- **XSS = key exposure.** The DEK lives in browser memory. A script-injection
  bug would expose it. Mitigations in place: strict CSP (`script-src 'self'
  'wasm-unsafe-eval'`), no inline scripts, message rendering via `textContent`
  (never `innerHTML`). Preserve these invariants in any change.
- **Metadata leakage.** Counts, timestamps, sizes are visible to the host.
  Padding/normalization is not implemented.
- **Argon2id params** (`64 MiB / t=3 / p=1`) are set in `public/crypto.js`.
  Raise on capable hardware. `kdf_params` is stored per-vault so future
  re-tuning can be handled during a password rotation.
- **Backups.** DB backups contain only ciphertext — safe to store off-box.
  Losing the DB *and* everyone forgetting their vault password = unrecoverable.
- **Session store.** Identity sessions live in Postgres
  (`connect-pg-simple`), 12-hour expiry. This is separate from the vault.
- Not a medical device; the system prompt states it is not a substitute for a
  licensed clinician and points to crisis resources on risk language.

## File map

```
docker-compose.yml   app + postgres (app bound to 127.0.0.1:8080)
Dockerfile           node:22-alpine, non-root
server/
  index.js           express, helmet/CSP, session, route wiring
  auth.js            provider selector (AUTH_PROVIDER=local|entra)
  auth.local.js      local email+password (scrypt), allowlist
  auth.entra.js      Entra ID OIDC + PKCE provider
  db.js  initdb.js   pg pool + schema migration
  schema.sql         users, vaults(+api_key_enc), vault_history, memories,
                     conversations, messages (all content ciphertext)
  llm.js             provider-agnostic streaming + shared prompts
  routes/
    vault.js         wrapped-DEK / verifier / salt / api-key + rotation history
    conversations.js encrypted messages + transactional compaction
    chat.js          /config + proxy-mode chat/summarize/memorize
    memory.js        encrypted long-term case file (GET/PUT/DELETE)
public/
  crypto.js          Argon2id + AES-GCM envelope (WebCrypto)
  llm.js             direct-mode browser -> Anthropic transport
  app.js             vault gate, chat, streaming, compaction, memory, API key
  login.html login.js local sign-in page
  index.html styles.css
test/
  crypto.roundtrip.test.js   envelope-encryption invariants
  chat.validate.test.js      LLM-proxy payload guard
```
