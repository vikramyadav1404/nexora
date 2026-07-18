const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

// Local draft helpers (no external LLM required). Swap for real AI later.

// POST /api/ai/draft-answer
router.post('/draft-answer', protect, async (req, res) => {
  const { title = '', body = '', tone = 'helpful' } = req.body;
  const topic = title || 'this topic';
  const draft =
    `Here's a practical take on **${topic}**:\n\n` +
    `1. **Clarify the goal** — ${body ? 'Based on what you described, ' : ''}` +
    `start by restating the problem in one sentence so answers stay focused.\n` +
    `2. **Try the simplest fix first** — check inputs, edge cases, and recent changes before complex refactors.\n` +
    `3. **Share a minimal example** — a short snippet or steps to reproduce helps the community help you faster.\n` +
    `4. **Next steps** — if that doesn't work, compare against a known-good baseline and isolate what differs.\n\n` +
    `Happy to refine this if you share more details (errors, versions, what you already tried).`;
  res.json({
    draft,
    tone,
    note: 'Local AI-style draft (no external model). Edit before posting.'
  });
});

// POST /api/ai/draft-question
router.post('/draft-question', protect, async (req, res) => {
  const { topic = '', details = '' } = req.body;
  const title = topic
    ? `How do I ${topic.trim().replace(/\?$/, '')}?`
    : 'How should I approach this problem?';
  const body =
    `### What I'm trying to do\n${details || 'Describe your goal here.'}\n\n` +
    `### What I've tried\n- \n\n` +
    `### Expected vs actual\n- Expected:\n- Actual:\n\n` +
    `### Environment\n- Stack / versions:\n`;
  res.json({ title, body, note: 'Structured question draft — edit before posting.' });
});

module.exports = router;
