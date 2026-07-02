// ============================================================================
// REFERENCE ONLY — not wired up in the test build.
// This is the Entra ID (Azure AD) auth provider. To switch back to Entra later:
//   1. `npm install @azure/msal-node`
//   2. Replace server/auth.js with this file's contents.
//   3. Restore ENTRA_* vars in .env (see README "Migrating to Entra").
//   4. Add a users.id migration note: Entra uses the object id (oid) as the PK;
//      the local-auth build uses a generated uuid. Don't mix the two on one DB.
// ============================================================================
// Entra ID (Azure AD) OpenID Connect: authorization code + PKCE, confidential client.
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
