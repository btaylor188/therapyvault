# Vault Therapy

A two-user AI therapy chat with **zero-knowledge-at-rest** storage and
**automatic session compaction**. Runs in Docker.

> **This is the test build:** sign-in is local email+password (no Azure), and no
> tunnel is bundled — you run your own. The Entra ID provider is kept in
> `server/auth.entra.js` for later (see "Migrating to Entra"). The vault /
> encryption layer is identical to the production design.

Built to a specific privacy contract: as the admin/host you can read the
database and the container, and you will see **only ciphertext**. You cannot read
either user's session history.

---

## What "zero-knowledge at rest" means here (read this)

| Data | Where it lives | Can the admin read it? |
|---|---|---|
| Session history (messages, titles, summaries) | Postgres, `AES-GCM(DEK)` ciphertext | **No** — needs the vault password, which is never sent to the server |
| Vault password | Nowhere. Typed in the browser each unlock | **No** |
| Derived key (KEK) / data key (DEK) | Browser memory only, cleared on lock | **No** |
| **Live message being sent to the AI** | Server RAM, transiently, in-request | **Yes, in principle** |

The last row is the unavoidable caveat with a hosted LLM: to get a reply, the
browser decrypts and sends **plaintext over TLS** to `/api/chat`, which forwards
it to Anthropic/OpenAI. That plaintext is **never written to the database or
logs** — but it exists in the server process for the duration of the request,
and the LLM provider receives it under their API data terms. Stored history is
zero-knowledge; live inference is not. This matches the design you chose.

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
decrypt for send ─plaintext(TLS)──────▶ /api/chat (proxy) ──────▶ Anthropic/OpenAI
                                          (no persistence)          (streams reply)
email+password sign-in (scrypt) ───────▶ /auth/* (identity only)
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
tokens it asks the model (via `/api/summarize`) to fold the oldest turns —
plus any previous summary — into a ~300-word continuity memo, encrypts it, and
stores it while marking the folded turns `archived`. The newest
`COMPACT_KEEP_RECENT` turns stay verbatim. Archived turns remain in the DB
(encrypted) but are no longer sent to the model. The memo is injected into the
system prompt on subsequent turns.

---

## Setup (test build)

> This build uses **local email+password auth** (no Azure) and does **not**
> bundle a tunnel — run your own (Cloudflare Tunnel, etc.) pointed at
> `http://localhost:8080`. See "Migrating to Entra" and "Serving publicly" below.

### 1. Configure

```bash
cp .env.example .env
openssl rand -hex 48        # -> paste into SESSION_SECRET
```

Fill in `ALLOWED_USERS` (the emails allowed to sign in), `POSTGRES_*` +
`DATABASE_URL`, and the `LLM_*` block (`LLM_PROVIDER=anthropic|openai`,
`LLM_MODEL`, `LLM_API_KEY`). For local testing leave `NODE_ENV=development` and
`BASE_URL=http://localhost:8080`.

### 2. Run

```bash
docker compose up -d --build
```

The app container runs the schema migration (`initdb.js`) then starts on
`127.0.0.1:8080`. Open `http://localhost:8080`.

### 3. First use

1. **Sign in.** Enter an email from `ALLOWED_USERS` and a password. The first
   sign-in for that email *registers* it (sets the password). Do this once per
   person. Non-allowlisted emails are rejected.
2. **Set a vault password** (min 10 chars) when prompted. This is separate from
   the login password, never leaves the browser, encrypts all history, and
   cannot be recovered or reset by the admin.

Auth here is deliberately minimal — it exists so the two accounts are separated
and the tunnel isn't wide open. The real privacy guarantee is the vault layer,
which is identical to the production design.

### Serving publicly (your own tunnel)

Point your tunnel at `http://localhost:8080`. When it terminates TLS and
forwards `X-Forwarded-Proto: https`, set `NODE_ENV=production` and
`BASE_URL=https://your-host` so the session cookie is marked `Secure`
(`trust proxy` is already enabled). Adding an edge access policy (e.g.
Cloudflare Access limited to your two emails) is recommended as a second gate.

### Migrating to Entra later

The Entra provider is preserved verbatim in `server/auth.entra.js`. To switch:
`npm install @azure/msal-node`, replace `server/auth.js` with that file, restore
the `ENTRA_*` vars, and register the app (Web redirect URI
`https://YOUR_HOST/auth/callback`, client secret, `openid profile email`).
Note: Entra keys users by object id (`oid`); this test build uses generated
UUIDs — don't point both auth modes at the same populated database.

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

- **Live plaintext.** Covered above — inherent to hosted-LLM inference. If you
  ever want plaintext to never leave your hardware, swap `LLM_PROVIDER` for a
  local model (Ollama) behind the same interface; `llm.js` is provider-agnostic.
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
docker-compose.yml   app + postgres
Dockerfile           node:22-alpine, non-root
server/
  index.js           express, helmet/CSP, session, route wiring
  auth.js            local email+password (scrypt), allowlist
  auth.entra.js      Entra OIDC provider — reference only, not wired up
  db.js  initdb.js   pg pool + schema migration
  schema.sql         users, vaults, conversations, messages (ciphertext)
  llm.js             provider-agnostic streaming (anthropic|openai)
  routes/
    vault.js         wrapped-DEK / verifier / salt (ciphertext only)
    conversations.js encrypted messages + transactional compaction
    chat.js          streaming LLM proxy + summarize + /config
public/
  crypto.js          Argon2id + AES-GCM envelope (WebCrypto)
  app.js             vault gate, chat, streaming, auto-compaction
  login.html login.js local sign-in page
  index.html styles.css
test/crypto.roundtrip.test.js
```
