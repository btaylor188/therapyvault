# CLAUDE.md — project guardrails for the coding agent

Vault Therapy: a two-user, zero-knowledge-at-rest AI therapy chat (Docker,
Node 22 + Postgres 16). Read `HANDOFF.md` for full context and the prioritized
backlog. This file is the short list of things not to break.

## Current build
- **Test build:** local email+password auth (`server/auth.js`, scrypt), no
  Azure, no bundled tunnel. Entra provider preserved at `server/auth.entra.js`.
- Vault/encryption layer is production-grade and identical to the final design.

## Security invariants — do NOT violate
- Server stores/logs **ciphertext only**, plus non-sensitive metadata. The LLM
  proxy (`server/routes/chat.js`) sees plaintext transiently in-request and must
  never persist or log it. Keep the generic 500 error handler.
- Vault password, KEK, and DEK **never leave the browser**. Server only ever
  receives `kdf_salt`, `kdf_params`, `wrapped_dek`, `verifier`, and ciphertext.
- DEK lives in **browser memory only** — never localStorage/sessionStorage/cookies.
- Keep CSP strict: `script-src 'self' 'wasm-unsafe-eval'`, **no inline scripts**.
  Render user/AI content with `textContent`, never `innerHTML`.
- Every DB query is **scoped to `req.session.user.id`**. Preserve the
  `ownsConversation` ownership checks in `routes/conversations.js`.
- Preserve `auth.js` exports (`requireAuth`, `registerAuthRoutes`) and the
  `req.session.user = { id, email }` shape so swapping back to Entra is one file.

## Crypto specifics
- Envelope: vault pw → Argon2id(salt) → KEK (AES-GCM); random 256-bit DEK wrapped
  under KEK. Wrong password is caught by the AES-GCM auth tag on `verifier`.
- Argon2 params live in `public/crypto.js` (`ARGON2_PARAMS`); `kdf_params` is
  stored per-vault so they can be re-tuned during a password rotation.
- Password rotation re-wraps the same DEK (keeps history readable).

## Dev commands
- `npm run check` — syntax-check server modules.
- `npm run test:crypto` — envelope-encryption invariants (no DB needed).
- `docker compose up -d --build` — full stack (app + postgres) on `127.0.0.1:8080`.
- Add tests when you add behavior. If you touch crypto, the crypto test must
  still pass and ideally gain a case.

## Before changing auth or ingress
This is a test build on purpose. If asked to add Entra or a tunnel, see the
"Migrating to Entra" and "Serving publicly" sections of `README.md` — don't
reinvent them.
