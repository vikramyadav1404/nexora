const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { shapeUser } = require('../db/helpers');
const {
  CHALLENGES, touchUserActivity, pushNotification
} = require('../db/features');

// GET /api/challenges
router.get('/', protect, async (req, res) => {
  try {
    const raw = req.userRow || {};
    let progress = raw.challenge_progress || {};
    if (typeof progress === 'string') {
      try { progress = JSON.parse(progress); } catch { progress = {}; }
    }
    const streak = raw.streak_count || 0;

    const list = CHALLENGES.map(c => {
      const current = c.metric === 'streak' ? streak : (progress[c.metric] || 0);
      return {
        ...c,
        current: Math.min(current, c.goal),
        completed: current >= c.goal,
        percent: Math.min(100, Math.round((current / c.goal) * 100))
      };
    });

    res.json({
      challenges: list,
      streak: {
        count: streak,
        lastActivityDate: raw.last_activity_date || null
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/challenges/check-in
router.post('/check-in', protect, async (req, res) => {
  try {
    const updated = await touchUserActivity(req.user.id, req.userRow);
    await pushNotification(req.user.id, {
      type: 'streak',
      title: `🔥 ${updated.streak_count || 0}-day streak!`,
      body: 'Keep showing up. Consistency builds reputation.',
      link: '/challenges'
    });

    res.json({
      message: 'Checked in',
      streakCount: updated.streak_count || 0,
      user: shapeUser(updated)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
