import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pool } from './db.js';
import { registerAuthRoutes, requireAuth, AUTH_PROVIDER } from './auth.js';
import vaultRoutes from './routes/vault.js';
import conversationRoutes from './routes/conversations.js';
import configRoutes from './routes/config.js';
import memoryRoutes from './routes/memory.js';
import prefsRoutes from './routes/prefs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PROD = process.env.NODE_ENV === 'production';

// Behind a TLS-terminating reverse proxy in production.
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'wasm-unsafe-eval' is required for the Argon2id WASM module (hash-wasm).
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'"],
        // api.anthropic.com: the browser streams from Anthropic itself so
        // plaintext never touches this server.
        connectSrc: ["'self'", 'https://api.anthropic.com'],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        // Trusted Types: DOM XSS sinks (innerHTML etc.) throw at the platform
        // level. The client uses textContent/replaceChildren exclusively —
        // enforced by `npm run check` (check:dom).
        requireTrustedTypesFor: ["'script'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '2mb' }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: PROD,
      maxAge: 1000 * 60 * 60 * 12, // 12h identity session
    },
  })
);

// Auth (identity) routes.
registerAuthRoutes(app);

// API (all require an authenticated session).
app.use('/api/vault', vaultRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/prefs', prefsRoutes);
app.use('/api', configRoutes);

// Serve the Argon2id WASM bundle from the installed package.
app.use(
  '/vendor/hash-wasm',
  express.static(join(__dirname, '..', 'node_modules', 'hash-wasm', 'dist'), {
    immutable: true,
    maxAge: '30d',
  })
);

// Login page (public — no auth required). Under Entra there is no local login
// form; send the browser straight into the OIDC flow.
app.get('/login', (req, res) => {
  if (AUTH_PROVIDER === 'entra') return res.redirect('/auth/login');
  res.sendFile(join(__dirname, '..', 'public', 'login.html'));
});

// App shell + assets. Require auth for the shell so unauthenticated users hit
// login. /index.html is gated explicitly too — otherwise express.static would
// serve it without auth (registered routes win over the static middleware).
const shell = (req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html'));
app.get('/', requireAuth, shell);
app.get('/index.html', requireAuth, shell);
app.use(express.static(join(__dirname, '..', 'public'), { index: false }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Error handler: never leak internals or plaintext.
app.use((err, req, res, next) => {
  console.error('[error]', err?.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`[app] listening on :${PORT}`));
