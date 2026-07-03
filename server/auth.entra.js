// Entra ID (Azure AD) auth provider. Selected via AUTH_PROVIDER=entra in
// server/auth.js (which loads this module — and @azure/msal-node — only when
// selected). Requires ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET
// and BASE_URL; register the app with Web redirect URI
// {BASE_URL}/auth/callback and scopes openid profile email.
// See README "Switching to Entra".
//
// NOTE: Entra keys users by object id (oid); local auth uses generated UUIDs.
// Do not point both providers at the same populated database — the callback
// below detects and refuses the email collision rather than corrupting data.
//
// Entra ID OpenID Connect: authorization code + PKCE, confidential client.
// Auth establishes IDENTITY ONLY. It does not unlock the vault.
import { ConfidentialClientApplication, CryptoProvider } from '@azure/msal-node';
import { q } from './db.js';

const TENANT = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;
const CLIENT_SECRET = process.env.ENTRA_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const SCOPES = ['openid', 'profile', 'email'];

const ALLOWED = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const msal = new ConfidentialClientApplication({
  auth: {
    clientId: CLIENT_ID,
    authority: `https://login.microsoftonline.com/${TENANT}`,
    clientSecret: CLIENT_SECRET,
  },
});
const cryptoProvider = new CryptoProvider();

function isAllowed(claims) {
  const oid = (claims.oid || '').toLowerCase();
  const email = (claims.preferred_username || claims.email || '').toLowerCase();
  return ALLOWED.includes(oid) || ALLOWED.includes(email);
}

export function requireAuth(req, res, next) {
  if (req.session?.user?.id) return next();
  if (req.accepts('html')) return res.redirect('/auth/login');
  return res.status(401).json({ error: 'unauthenticated' });
}

export function registerAuthRoutes(app) {
  app.get('/auth/login', async (req, res, next) => {
    try {
      const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
      const state = cryptoProvider.base64Encode(cryptoProvider.createNewGuid());
      req.session.pkce = { verifier, state };
      const url = await msal.getAuthCodeUrl({
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        state,
        prompt: 'select_account',
      });
      res.redirect(url);
    } catch (e) {
      next(e);
    }
  });

  app.get('/auth/callback', async (req, res, next) => {
    try {
      const saved = req.session.pkce;
      if (!saved || req.query.state !== saved.state) {
        return res.status(400).send('Invalid auth state. <a href="/auth/login">Try again</a>.');
      }
      const result = await msal.acquireTokenByCode({
        code: req.query.code,
        scopes: SCOPES,
        redirectUri: REDIRECT_URI,
        codeVerifier: saved.verifier,
      });
      delete req.session.pkce;

      const claims = result.idTokenClaims || {};
      if (!isAllowed(claims)) {
        req.session.destroy(() => {});
        return res.status(403).send('This account is not permitted to use this application.');
      }

      const id = claims.oid;
      const email = (claims.preferred_username || claims.email || '').toLowerCase();

      // Refuse a mixed database: if this email already exists under a
      // different id (i.e. a local-auth UUID), upserting a second user row
      // would orphan the existing vault/history. Admin must migrate or reset.
      const { rows: existing } = await q(
        `SELECT id FROM users WHERE lower(email) = $1`,
        [email]
      );
      if (existing.length && existing[0].id !== id) {
        req.session.destroy(() => {});
        console.error(
          `[auth.entra] refusing sign-in: ${email} already exists under a different ` +
          `user id (created by local auth). Migrate users.id to the Entra oid or use a fresh DB.`
        );
        return res
          .status(409)
          .send('This account exists under a different sign-in method. Contact the administrator.');
      }

      await q(
        `INSERT INTO users (id, email) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [id, email]
      );

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { id, email };
        res.redirect('/');
      });
    } catch (e) {
      next(e);
    }
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      const logout = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout` +
        `?post_logout_redirect_uri=${encodeURIComponent(BASE_URL)}`;
      res.json({ redirect: logout });
    });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.session.user.id, email: req.session.user.email });
  });
}
