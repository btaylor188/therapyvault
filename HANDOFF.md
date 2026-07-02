# Session Handoff — Vault Therapy

Context transfer for continuing development in Claude Code on a VM. Read this
first, then `README.md` (setup) and `CLAUDE.md` (invariants the coding agent
must not break).

---

## 1. What this is

A two-user AI therapy chat (each user talks privately to an LLM) with
**zero-knowledge-at-rest** storage and **automatic session compaction**, in
Docker. Built for one couple's personal use, not a product.

### Three product decisions already locked (do not relitigate silently)

1. **AI therapist**, not human-to-human. Each user has private sessions with an
   LLM. (A *shared* couples mode is a possible future addition — see backlog.)
2. **Zero-knowledge at rest.** The DB stores only ciphertext. The admin/host
   cannot read stored history. The honest caveat: live turns pass through server
   RAM in-request to reach the LLM — never persisted or logged. Stored history
   is zero-knowledge; live inference is not. This is inherent to a hosted LLM.
3. **LLM backend = Anthropic/OpenAI API** (provider-agnostic interface).

---

## 2. Current state: TEST BUILD

The repo is currently a **test build**, deliberately simplified from the
production target:

| Concern | Production target | Test build (current) |
|---|---|---|
| Auth | Entra ID (OIDC + PKCE) | Local email+password (scrypt) |
| Ingress | Cloudflare Tunnel | None bundled — user runs own tunnel |
| TLS/cookie | `Secure`, behind tunnel | `NODE_ENV=development`, plain http localhost |

- Entra provider is preserved verbatim at `server/auth.entra.js` (not wired up).
- Cloudflare was removed from `docker-compose.yml`; app binds `127.0.0.1:8080`.
- The **vault / encryption layer is identical to production** — the test
  simplifications are only identity + ingress, never the privacy boundary.

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
decrypt for send ─plaintext(TLS)──────▶ /api/chat (proxy) ──────▶ Anthropic/OpenAI
                                          (no persistence)          (streams reply)
local login (email+pw, scrypt) ────────▶ /auth/* (identity only)
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
docker-compose.yml     app + postgres (test: no cloudflared)
Dockerfile             node:22-alpine, non-root
package.json           deps: express, express-session, connect-pg-simple,
                             pg, helmet, hash-wasm, dotenv  (NO msal in test)
.env.example           copy to .env
server/
  index.js             express, helmet/CSP, session, route wiring, /login
  auth.js              LOCAL auth (scrypt) — CURRENT
  auth.entra.js        Entra provider — REFERENCE ONLY, swap in later
  db.js  initdb.js     pg pool + idempotent schema migration
  schema.sql           users, vaults, conversations, messages (ciphertext)
  llm.js               provider-agnostic streaming (anthropic|openai) + DEFAULT_SYSTEM
  routes/
    vault.js           wrapped-DEK / verifier / salt (ciphertext only)
    conversations.js   encrypted messages + transactional compaction commit
    chat.js            streaming LLM proxy + /summarize + /config
public/
  index.html app.js    app shell + vault gate + chat + streaming + auto-compaction
  crypto.js            Argon2id + AES-GCM envelope (WebCrypto + hash-wasm WASM)
  login.html login.js  test-build sign-in page
  styles.css
test/crypto.roundtrip.test.js
README.md  HANDOFF.md  CLAUDE.md
```

---

## 5. How to run on the VM

```bash
cp .env.example .env
openssl rand -hex 48            # -> SESSION_SECRET
# edit .env: ALLOWED_USERS, POSTGRES_*/DATABASE_URL, LLM_PROVIDER/MODEL/API_KEY
docker compose up -d --build
# open http://localhost:8080
```

First sign-in with an allowlisted email registers it (sets password). Then set a
vault password (min 10 chars). Local dev without Docker: `npm install`,
`npm run check`, `npm run test:crypto` (crypto test needs no DB).

> Path note: this repo was authored under a Windows Cowork workspace. On the VM
> it's just a normal Node project — ignore any absolute Windows paths in old
> chat history. `node_modules/` is git-ignored; do a fresh `npm install`.

---

## 6. Backlog — prioritized (from a design-gap review)

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
- Keep `auth.js` exports (`requireAuth`, `registerAuthRoutes`) and the
  `req.session.user = { id, email }` shape so the Entra swap-back stays a
  one-file change.
