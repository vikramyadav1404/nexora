const { protect } = require('./auth');

/** Require authenticated admin role */
function requireAdmin(req, res, next) {
  protect(req, res, () => {
    const role = req.userRow?.role || req.user?.role || 'user';
    if (role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAdmin };
