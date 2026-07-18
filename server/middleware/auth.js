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
