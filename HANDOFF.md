# Session Handoff — Vault Therapy

Context transfer for continuing development in Claude Code on a VM. Read this
first, then `README.md` (setup) and `CLAUDE.md` (invariants the coding agent
must not break).

---

## 1. What this is

An AI therapy chat (each user talks privately to an LLM) with
**zero-knowledge-at-rest** storage and **automatic session compaction**, in
Docker. Personal use, not a product. User count is not structural: access is
just the `ALLOWED_USERS` email allowlist (one user or several), and all data
is strictly per-user. Originally framed for a couple — hence the "shared
couples mode" idea in the backlog — but it runs fine single-user.

### Three product decisions already locked (do not relitigate silently)

1. **AI therapist**, not human-to-human. Each user has private sessions with an
   LLM. (A *shared* couples mode is a possible future addition — see backlog.)
2. **Zero-knowledge at rest.** The DB stores only ciphertext. The admin/host
   cannot read stored history.
   - In **direct mode** (`LLM_MODE=direct`, the default): the browser calls
     Anthropic directly with the user's own key (stored DEK-encrypted in the
     vault). **Plaintext never touches the app server at all** — the old
     "live turns pass through server RAM" caveat no longer applies. Plaintext
     exists only in the browser and at Anthropic during inference.
   - In **proxy mode** (legacy, needed for OpenAI): live turns pass through
     server RAM in-request — never persisted or logged. Inherent to relaying
     a hosted LLM.
3. **LLM backend = Anthropic/OpenAI API** (provider-agnostic interface).

---

## 2. Current state

Auth is now **selectable at runtime** (`AUTH_PROVIDER`), so the old test-build /
production split has collapsed into config:

| Concern | Production config | Test/local config |
|---|---|---|
| Auth | `AUTH_PROVIDER=entra` (OIDC + PKCE, `server/auth.entra.js`) | `AUTH_PROVIDER=local` (scrypt, `server/auth.local.js`) — default |
| LLM | `LLM_MODE=direct` (browser → Anthropic, per-user key) — default | same, or `LLM_MODE=proxy` for OpenAI/local models |
| Ingress | Your own tunnel + `NODE_ENV=production` | plain http localhost, `NODE_ENV=development` |

- `server/auth.js` is a thin provider selector; both providers share exports
  and the `req.session.user = { id, email }` shape. Entra's msal dependency is
  loaded only when selected.
- **Do not switch auth providers on a populated DB** (UUID vs oid user ids).
  The Entra callback refuses the email collision; see README "Switching to Entra".
- App binds `127.0.0.1:8080`; no tunnel bundled.
- The **vault / encryption layer is identical in all configurations** — config
  toggles never touch the privacy boundary.

### Verified working

- `npm run check` — syntax check of all server modules: pass.
- `npm run test:crypto` — 4/4 envelope-encryption invariants: pass
  (round-trip, wrong-password-rejected, ciphertext-only-at-rest, rotation-preserves-DEK).
- ES module import resolution of all server modules: pass (no stray deps).

### NOT yet done / untested

- No end-to-end run against a live Postgres has been executed by the author of
  this handoff (no DB/Docker in the authoring sandbox). **First task on the VM:
  `docker compose up` and click through login → vault → chat → compaction.**
- No integration/API tests. Only the standalone crypto unit test exists.
- No real LLM call has been exercised (needs a real `LLM_API_KEY`).

---

## 3. Architecture

```
Browser (per user)                     Server (Docker)              External
────────────────────                   ─────────────────            ────────
vault password ─Argon2id(salt)→ KEK
random DEK  ─AES-GCM(KEK)→ wrapped DEK ──POST /api/vault──▶ vaults (ciphertext)
message ─AES-GCM(DEK)→ ciphertext ─────POST /messages────▶ messages (ciphertext)
case file ─AES-GCM(DEK)→ ciphertext ───PUT /api/memory───▶ memories (ciphertext)
API key  ─AES-GCM(DEK)→ ciphertext ────PUT /api/vault/api-key▶ vaults (ciphertext)

direct mode (default): decrypt ─plaintext(TLS)────────────────────▶ Anthropic
                       (server never in the path)                  (streams reply)
proxy mode (legacy):   decrypt ─plaintext(TLS)─▶ /api/chat ───────▶ Anthropic/OpenAI
                                                 (no persistence)  (streams reply)

sign-in (local scrypt | Entra OIDC) ───▶ /auth/* (identity only)
```

### Crypto (the important part)

- **Identity ≠ decryption.** Login proves *who*; a separate **vault password**
  unlocks data. Compromising the login account does not reveal history.
- **Envelope encryption.** Per-user random 256-bit DEK, wrapped by a
  password-derived KEK (Argon2id). Vault password → KEK → unwrap DEK.
  DEK lives **only in browser memory** after unlock (never localStorage, never
  the server). Page reload = must re-enter vault password.
- **Wrong-password detection is cryptographic** — a verifier blob fails its
  AES-GCM auth tag. No password hash of the vault password is stored anywhere.
- **Password rotation re-wraps the same DEK**, so history stays readable.
- Server stores per user: `kdf_salt`, `kdf_params`, `wrapped_dek`, `verifier`,
  plus ciphertext messages + metadata (role, token estimate, timestamps).

### Compaction

Client tracks an approx token count. Past `COMPACT_TOKEN_THRESHOLD` it calls
`/api/summarize` to fold the oldest turns + any prior summary into a ~300-word
continuity memo, encrypts it, stores it, and marks folded turns `archived`
(kept in DB, encrypted, but no longer sent to the model). Newest
`COMPACT_KEEP_RECENT` turns stay verbatim. The memo is injected into the system
prompt on later turns. **Compaction is lossy and archived detail is never
resurfaced** — see backlog.

---

## 4. File map

```
docker-compose.yml     app + postgres (app bound to 127.0.0.1:8080)
Dockerfile             node:22-alpine, non-root
package.json           deps: express, express-session, connect-pg-simple,
                             pg, helmet, hash-wasm, dotenv, @azure/msal-node
env.example            copy to .env
server/
  index.js             express, helmet/CSP, session, route wiring, /login
  auth.js              provider selector (AUTH_PROVIDER=local|entra)
  auth.local.js        local auth (scrypt) — default
  auth.entra.js        Entra ID OIDC + PKCE provider
  db.js  initdb.js     pg pool + idempotent schema migration
  schema.sql           users, vaults(+api_key_enc), vault_history, memories,
                       conversations, messages (all content ciphertext)
  llm.js               provider-agnostic streaming + DEFAULT/SUMMARIZE/MEMORIZE prompts
  routes/
    vault.js           wrapped-DEK / verifier / salt / api-key; archives old
                       wrapping to vault_history on rotation
    conversations.js   encrypted messages + transactional compaction commit
    chat.js            /config (mode/model/prompts) + proxy-mode chat/summarize/memorize
    memory.js          encrypted long-term case file (GET/PUT/DELETE)
public/
  index.html app.js    app shell + vault gate + chat + streaming + compaction
                       + memory modal + API-key modal
  llm.js               direct-mode browser -> Anthropic transport
  crypto.js            Argon2id + AES-GCM envelope (WebCrypto + hash-wasm WASM)
  login.html login.js  local-auth sign-in page
  styles.css
test/crypto.roundtrip.test.js  test/chat.validate.test.js
README.md  HANDOFF.md  CLAUDE.md
```

---

## 5. How to run on the VM

```bash
cp env.example .env
openssl rand -hex 48            # -> SESSION_SECRET
# edit .env: ALLOWED_USERS, POSTGRES_*/DATABASE_URL, LLM_MODEL(S).
# LLM_MODE=direct (default) needs no server API key — users paste their own.
# AUTH_PROVIDER=entra additionally needs the ENTRA_* block.
docker compose up -d --build
# open http://localhost:8080
```

First sign-in with an allowlisted email registers it (local auth) or redirects
to Microsoft (Entra). Then set a vault password (min 10 chars) and, in direct
mode, paste your Anthropic API key when prompted. Local dev without Docker:
`npm install`, `npm run check`, `npm run test:crypto`, `npm run test:validate`
(tests need no DB).

> Path note: this repo was authored under a Windows Cowork workspace. On the VM
> it's just a normal Node project — ignore any absolute Windows paths in old
> chat history. `node_modules/` is git-ignored; do a fresh `npm install`.

---

## 6. Backlog — prioritized (from a design-gap review)

### Done since the original handoff

- **Direct LLM mode** — browser calls Anthropic with the user's own key
  (DEK-encrypted at `vaults.api_key_enc`); server out of the plaintext path.
- **Cross-session memory** — encrypted rolling case file (`memories` table,
  Memory modal, auto-refresh every ~8 messages).
- **Utility model split** — compaction/memory run on `LLM_MODEL_UTILITY`
  (Haiku) for cost.
- **Entra ID wired in** — `AUTH_PROVIDER=local|entra` selector, mixed-DB guard.
- **Hardening** — loopback port binding fixed, `/index.html` auth-gated,
  vault rotation archives the old wrapping to `vault_history` (hijacked-session
  overwrite is now recoverable).

### Critical (address before real data goes in)

1. **Vault password strength = the entire confidentiality boundary vs DB theft.**
   Argon2id runs client-side, so a stolen DB can be brute-forced offline with no
   server lockout possible. Replace the 10-char minimum with a real passphrase
   policy (zxcvbn strength meter, reject weak/common), and raise Argon2 memory
   (currently 64 MiB / t=3 / p=1 in `public/crypto.js`) toward 256 MiB+.
2. **Recovery code.** Forgotten vault password + no backup = permanent loss.
   Add an optional second wrapping of the DEK under a high-entropy random code
   shown once for the user to print/store. Preserves zero-knowledge.
3. **Crisis handling.** A therapy tool will receive self-harm language. Zero-
   knowledge forbids admin-side monitoring by construction, so the only lever is
   the model's response — strengthen crisis behavior in `DEFAULT_SYSTEM`
   (`server/llm.js`) and document that no human escalation exists.

### High value

4. **Postgres backups** (`pg_dump`) — none exist. Ciphertext backups are safe
   off-box. Add a backup service/cron + test a restore.
5. **Real tokenizer** — compaction triggers on `chars/4`; can mis-estimate and
   overflow the model's real context window.
6. **Data export + full account purge** — no way to get history out or erase a user.
7. **LLM cost controls** — no spend cap / rate limit on the proxy.

### Product / future

8. **Shared couples mode** — a jointly-readable conversation under a shared DEK
   both partners unlock, distinct from private solo sessions. Two private
   validating AIs can entrench conflict (triangulation); a shared channel is the
   real couples-therapy primitive. Non-trivial crypto (shared-key exchange).
9. **Retrieval over archived turns** — compaction is lossy; add client-side
   search/embeddings so old detail can resurface.
10. Stop/regenerate, message edit, therapeutic-modality selection (CBT/IFS/etc).

### Ops / hardening

- Integrity vs malicious host (host can delete/tamper ciphertext — availability,
  not confidentiality). MAC chain if in scope.
- Metadata leakage (counts, timestamps, sizes visible to host) — no padding.
- DEK rotation path (only password rotation exists today).
- Rotate the eventual Entra client secret before expiry (silent auth breakage).

---

## 7. Non-negotiable invariants (also in CLAUDE.md)

Do not break these in any change:

- **Server never stores or logs plaintext.** Only ciphertext + non-sensitive
  metadata at rest. The LLM proxy holds plaintext transiently and must not
  persist/log it. Keep the generic error handler.
- **Vault password / KEK / DEK never leave the browser** and are never sent to
  the server. Server sees only `salt`, `kdf_params`, `wrapped_dek`, `verifier`,
  and ciphertext.
- **DEK stays in memory only** — no localStorage/sessionStorage/cookies.
- **XSS hygiene:** strict CSP (`script-src 'self' 'wasm-unsafe-eval'`), no inline
  scripts (that's why login JS is external), render message content via
  `textContent`, never `innerHTML`.
- **Every data query is scoped to the authenticated user id.** No cross-user
  read path. Preserve `ownsConversation` checks.
- Keep the `auth.js` selector exports (`requireAuth`, `registerAuthRoutes`,
  `AUTH_PROVIDER`) and the `req.session.user = { id, email }` shape identical
  across both providers (`auth.local.js`, `auth.entra.js`).
