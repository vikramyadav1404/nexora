const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { shapeUser } = require('../db/helpers');

// pulls the user from the bearer token and hangs them on req
async function protect(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('JWT_SECRET missing');
    return res.status(500).json({ message: 'Server auth misconfigured' });
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded?.id) {
      return res.status(401).json({ message: 'Token invalid or expired' });
    }

    /*
     * A half-authenticated token must be useless here.
     *
     * Login with MFA enabled issues a short-lived token carrying
     * typ: 'mfa_pending'. It proves the password was correct and nothing more.
     * Only /api/auth/mfa/verify accepts it — every route reached through
     * `protect` must not.
     *
     * The check is default-deny by placement: it lives in the middleware every
     * protected route already uses, so a route added later is covered without
     * anyone remembering to add it to a list.
     */
    if (decoded.typ && decoded.typ !== 'access') {
      return res.status(401).json({ message: 'Additional verification required' });
    }

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

module.exports = { protect };
