const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { shapeUser } = require('../db/helpers');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: row, error } = await getSupabase()
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();

    if (error || !row) return res.status(401).json({ message: 'User not found' });

    req.user = shapeUser(row);
    req.userRow = row; // raw DB row for updates
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
};

module.exports = { protect };
