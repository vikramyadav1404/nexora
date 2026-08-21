const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { shapeUser } = require('../db/helpers');

/**
 * Decide whether a bearer token is a usable access token.
 *
 * Extracted because it was implemented twice and the copies drifted.
 * routes/auth.js's logout-all branch verified by hand and skipped two of the
 * three checks below: it accepted a typ: 'mfa_pending' token -- issued after a
 * correct password but before the second factor -- so someone with a stolen
 * password but blocked by MFA could still revoke every session the victim had.
 * It also fell back to a hardcoded secret.
 *
 * Returns { ok, decoded } or { ok: false, reason }. Never throws, so callers
 * branch on the value rather than on control flow.
 *
 * The reason exists because the messages are not interchangeable: a
 * half-authenticated token needs to tell the user to finish signing in, while
 * an expired one needs them to sign in again. Tests pin that distinction. One
 * function decides, each caller words it.
 */
function verifyAccessToken(token) {
  if (!token) return { ok: false, reason: 'missing' };

  const secret = process.env.JWT_SECRET;
  // No fallback. A missing secret must not become a known one -- see
  // utils/tokens.js jwtSecret().
  if (!secret) {
    console.error('JWT_SECRET missing');
    return { ok: false, reason: 'misconfigured' };
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded?.id) return { ok: false, reason: 'invalid' };

    /*
     * A half-authenticated token must be useless outside /api/auth/mfa/verify.
     *
     * Login with MFA enabled issues a short-lived token carrying
     * typ: 'mfa_pending'. It proves the password was correct and nothing more.
     *
     * Keeping this here rather than in each route is default-deny by
     * placement: everything that validates a token gets it, so a route added
     * later is covered without anyone remembering a list. logout-all is the
     * proof that the alternative fails -- it hand-rolled its own verify and
     * omitted exactly this.
     *
     * `typ` absent is treated as an access token, for tokens issued before the
     * claim existed; anything present and not 'access' is refused.
     */
    if (decoded.typ && decoded.typ !== 'access') {
      return { ok: false, reason: 'mfa_pending' };
    }

    return { ok: true, decoded };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** Bearer token out of the Authorization header, or null. */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

// pulls the user from the bearer token and hangs them on req
async function protect(req, res, next) {
  const token = bearerToken(req);

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  // Same validation logout-all uses, so the two cannot drift again.
  const result = verifyAccessToken(token);
  if (!result.ok) {
    if (result.reason === 'misconfigured') {
      return res.status(500).json({ message: 'Server auth misconfigured' });
    }
    if (result.reason === 'mfa_pending') {
      return res.status(401).json({ message: 'Additional verification required' });
    }
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
  const decoded = result.decoded;

  try {
    const { data: row, error } = await getSupabase()
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !row) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (row.is_active === false) {
      return res.status(403).json({ message: 'This account has been deactivated' });
    }

    req.user = shapeUser(row);
    req.userRow = row;
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
}

module.exports = { protect, verifyAccessToken, bearerToken };
