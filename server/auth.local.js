// LOCAL auth provider (test build / no Azure). Email + password, scrypt-hashed.
// Auth establishes IDENTITY ONLY. It does not unlock the vault (that's the
// separate vault password, zero-knowledge). Selected via AUTH_PROVIDER=local
// (the default) in server/auth.js — same exports, same session shape as the
// Entra provider (server/auth.entra.js).
import { randomBytes, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scryptAsync = promisify(scrypt);

// Only these emails may sign in (or self-register on first login).
const ALLOWED = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MIN_PW = 8;

// --- password hashing (scrypt; format: scrypt$N$saltHex$hashHex) ---
const N = 16384; // CPU/memory cost
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(pw, salt, 32, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${dk.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [scheme, nStr, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const dk = await scryptAsync(pw, salt, expected.length, { N: Number(nStr) });
    return timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

export function requireAuth(req, res, next) {
  if (req.session?.user?.id) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthenticated' });
}

export function registerAuthRoutes(app) {
  // Email + password login. First login for an allowlisted email sets its
  // password (self-registration). Response reveals nothing about which factor
  // failed, to avoid account enumeration.
  app.post('/auth/login', async (req, res, next) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const fail = () => res.status(401).json({ error: 'Invalid email or password.' });

      if (!email || !password) return fail();
      if (!ALLOWED.includes(email)) return fail();

      const { rows } = await q(
        `SELECT id, email, pw_hash FROM users WHERE email = $1`,
        [email]
      );

      let user = rows[0];
      if (!user) {
        // First-time registration for an allowlisted email.
        if (password.length < MIN_PW) {
          return res.status(400).json({ error: `Password must be at least ${MIN_PW} characters.` });
        }
        const id = randomUUID();
        const pw_hash = await hashPassword(password);
        await q(
          `INSERT INTO users (id, email, pw_hash) VALUES ($1, $2, $3)`,
          [id, email, pw_hash]
        );
        user = { id, email };
      } else {
        if (!user.pw_hash || !(await verifyPassword(password, user.pw_hash))) return fail();
      }

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { id: user.id, email: user.email };
        res.json({ ok: true });
      });
    } catch (e) {
      next(e);
    }
  });

  app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ redirect: '/login' }));
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.session.user.id, email: req.session.user.email });
  });
}
