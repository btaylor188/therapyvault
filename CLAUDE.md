# CLAUDE.md — project guardrails for the coding agent

Vault Therapy: an allowlist-gated (`ALLOWED_USERS`, any number of users),
zero-knowledge-at-rest AI therapy chat (Docker,
Node 22 + Postgres 16). Read `HANDOFF.md` for full context and the prioritized
backlog. This file is the short list of things not to break.

## Current build
- **Auth is env-selectable:** `AUTH_PROVIDER=local` (default; scrypt,
  `server/auth.local.js`) or `entra` (OIDC + PKCE, `server/auth.entra.js`),
  chosen by the selector in `server/auth.js`. No bundled tunnel.
- **Never point both auth providers at the same populated DB** (UUID vs oid
  user ids). The Entra callback refuses email collisions — keep that guard.
- Vault/encryption layer is production-grade and identical in all configs.

## Security invariants — do NOT violate
- Server stores/logs **ciphertext only**, plus non-sensitive metadata.
- **LLM access is browser-direct only** (proxy mode was removed): the
  **browser** calls Anthropic itself with the user's own key (stored
  DEK-encrypted at `vaults.api_key_enc`, decrypted to memory only). Plaintext
  never touches the server — there is no server-side LLM transport at all
  (`server/prompts.js` is prompts only; `server/routes/config.js` serves
  non-secret config). Do not add a server hop back into this path.
  Keep the generic 500 error handler.
- Vault password, KEK, DEK, and the plaintext API key **never
  leave the browser**, except the key going straight to Anthropic over TLS.
  Server only ever receives `kdf_salt`, `kdf_params`, `wrapped_dek`,
  `verifier`, and ciphertext (incl. `api_key_enc`).
- DEK lives in **browser memory only** — never localStorage/sessionStorage/cookies.
- Keep CSP strict: `script-src 'self' 'wasm-unsafe-eval'`, **no inline scripts**.
  Render user/AI content with `textContent`, never `innerHTML`.
- Every DB query is **scoped to `req.session.user.id`**. Preserve the
  `ownsConversation` ownership checks in `routes/conversations.js`.
- Preserve the `auth.js` selector exports (`requireAuth`, `registerAuthRoutes`,
  `AUTH_PROVIDER`) and keep the `req.session.user = { id, email }` shape
  identical across both providers.

## Crypto specifics
- Envelope: vault pw → Argon2id(salt) → KEK (AES-GCM); random 256-bit DEK wrapped
  under KEK. Wrong password is caught by the AES-GCM auth tag on `verifier`.
- Argon2 params live in `public/crypto.js` (`ARGON2_PARAMS`); `kdf_params` is
  stored per-vault so they can be re-tuned during a password rotation.
- Password rotation re-wraps the same DEK (keeps history readable).

## Dev commands
- `npm run check` — syntax-check server modules.
- `npm run test:crypto` — envelope-encryption invariants (no DB needed).
- `npm run test:prompts` — prompt/style-catalog sanity checks (no DB needed).
- `docker compose up -d --build` — full stack (app + postgres) on `127.0.0.1:8080`.
- Add tests when you add behavior. If you touch crypto, the crypto test must
  still pass and ideally gain a case.

## Before changing auth or ingress
Auth providers are selected by env (`AUTH_PROVIDER`), not by editing code — see
README "Switching to Entra" for the app-registration steps and the mixed-DB
warning. For tunnels/TLS see README "Serving publicly". Don't reinvent either.
