// Auth provider selector. Auth establishes IDENTITY ONLY — it never touches
// the vault layer, and both providers use the same exports and session shape:
//   requireAuth, registerAuthRoutes, req.session.user = { id, email }
//
//   AUTH_PROVIDER=local (default): email+password, scrypt  (server/auth.local.js)
//   AUTH_PROVIDER=entra          : Entra ID OIDC + PKCE    (server/auth.entra.js)
//
// The Entra module (and its @azure/msal-node dependency) is only loaded when
// selected. WARNING: the providers key users differently (generated UUID vs
// Entra oid) — do not point both at the same populated database. See
// README "Switching to Entra".
export const AUTH_PROVIDER = (process.env.AUTH_PROVIDER || 'local').toLowerCase();

const impl =
  AUTH_PROVIDER === 'entra'
    ? await import('./auth.entra.js')
    : await import('./auth.local.js');

export const requireAuth = impl.requireAuth;
export const registerAuthRoutes = impl.registerAuthRoutes;
