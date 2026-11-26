// Admin-Authentifizierung im Headhunter-Stil:
// - Google Identity Services ID-Token (GOOGLE_CLIENT_ID) + ADMIN_BOOTSTRAP_EMAILS Allowlist
// - httpOnly SameSite=Lax Session-Cookie in admin_sessions (SHA-256 gehasht)
// - Nicht-Admins erhalten auf /api/admin/* strikt 404 (keine Existenzbestätigung)
// - Optionaler lokaler Dev-Token nur außerhalb von NODE_ENV=production
'use strict';

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const COOKIE_NAME = 'aura_admin_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function createAuth(db, opts = {}) {
  const googleClientId = opts.googleClientId ?? process.env.GOOGLE_CLIENT_ID ?? '';
  const oauthClient = googleClientId ? new OAuth2Client(googleClientId) : null;
  const bootstrapAdmins = new Set(
    String(opts.adminEmails ?? process.env.ADMIN_BOOTSTRAP_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const devToken =
    process.env.NODE_ENV === 'production' ? '' : String(opts.devAdminToken ?? process.env.DEV_ADMIN_TOKEN ?? '');

  function isBootstrapAdmin(email) {
    return Boolean(email) && bootstrapAdmins.has(String(email).toLowerCase());
  }

  async function verifyGoogleCredential(credential) {
    if (!oauthClient || !googleClientId) {
      throw new Error('GOOGLE_CLIENT_ID ist auf dem Server nicht konfiguriert.');
    }
    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const p = ticket.getPayload();
    if (!p || !p.sub || !p.email || p.email_verified === false) {
      throw new Error('Google-Anmeldung ungültig oder E-Mail nicht verifiziert.');
    }
    return {
      googleId: p.sub,
      email: p.email.toLowerCase(),
      name: p.name || p.email.split('@')[0],
      avatarUrl: p.picture || null
    };
  }

  async function upsertAdminUser(profile, { allowDevBypass = false } = {}) {
    const allow = allowDevBypass || isBootstrapAdmin(profile.email);
    if (!allow) {
      return null;
    }
    const r = await db.query(
      `INSERT INTO admin_users (google_id, email, name, avatar_url, is_admin, last_login_at)
       VALUES ($1, $2, $3, $4, true, NOW())
       ON CONFLICT (email) DO UPDATE SET
         google_id = COALESCE(EXCLUDED.google_id, admin_users.google_id),
         name = EXCLUDED.name,
         avatar_url = COALESCE(EXCLUDED.avatar_url, admin_users.avatar_url),
         is_admin = true,
         last_login_at = NOW()
       RETURNING id, email, name, avatar_url, is_admin`,
      [profile.googleId || null, profile.email, profile.name || '', profile.avatarUrl || null]
    );
    return r.rows[0];
  }

  async function createSession(userId, res) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query('INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      hashToken(raw),
      userId,
      expiresAt
    ]);
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, raw, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_MS
    });
    return raw;
  }

  async function destroySession(req, res) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[COOKIE_NAME];
    if (raw) {
      await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(raw)]);
    }
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  async function resolveUser(req) {
    // 1. Dev-Bearer-Token (streng nur außerhalb von production)
    const authHeader = String(req.headers.authorization || '');
    if (devToken && authHeader.startsWith('Bearer ')) {
      const provided = authHeader.slice(7).trim();
      const a = Buffer.from(provided);
      const b = Buffer.from(devToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { id: 0, email: 'dev@aura.local', name: 'Local Dev Admin', is_admin: true };
      }
    }
    // 2. Session-Cookie
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    const r = await db.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.is_admin
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(raw)]
    );
    return r.rows[0] || null;
  }

  async function requireAdmin(req, res, next) {
    try {
      const user = await resolveUser(req);
      if (!user || !user.is_admin) {
        return res.status(404).json({ error: 'Not found.' });
      }
      req.adminUser = user;
      return next();
    } catch {
      return res.status(500).json({ error: 'Authentication error.' });
    }
  }

  return {
    googleConfigured: () => Boolean(googleClientId),
    googleClientId: () => googleClientId,
    devLoginEnabled: () => Boolean(devToken),
    devTokenMatches: (candidate) => {
      if (!devToken || !candidate) return false;
      const a = Buffer.from(String(candidate));
      const b = Buffer.from(devToken);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
    verifyGoogleCredential,
    upsertAdminUser,
    createSession,
    destroySession,
    resolveUser,
    requireAdmin
  };
}

module.exports = { createAuth, parseCookies, hashToken };
