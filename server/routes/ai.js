const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimit');
const { sanitizeText } = require('../utils/validate');
const { INTERESTS } = require('../db/interests');
const {
  isConfigured, complete, completeStructured, streamToSSE, friendlyMessage, statusFor
} = require('../utils/claude');

/**
 * AI assists, backed by Claude.
 *
 * These used to be string templates that pretended to be AI — /draft-answer
 * returned the same four numbered bullets regardless of the question.
 *
 * Cost shape: draft/improve are user-initiated (someone pressed a button),
 * tagging runs once per question, and moderation runs on the report queue
 * rather than on every write. All four share `aiLimiter` (40/hour/IP) so a
 * loop in a client can't run up a bill.
 */

router.use(protect, aiLimiter);

/** Uniform "not set up" response — these routes are optional. */
router.use((req, res, next) => {
  if (!isConfigured()) {
    return res.status(503).json({
      message: 'AI assists are not enabled on this server.',
      hint: 'Set ANTHROPIC_API_KEY in server/.env to turn them on.'
    });
  }
  next();
});

function fail(res, err) {
  console.error('[ai]', err.message);
  res.status(statusFor(err)).json({ message: friendlyMessage(err) });
}

/**
 * POST /api/ai/draft-answer  → streams SSE
 *
 * Streamed because a considered answer can outrun the client's 30s timeout.
 */
router.post('/draft-answer', async (req, res) => {
  const title = sanitizeText(req.body.title, 300);
  const body = sanitizeText(req.body.body, 4000);

  if (!title && !body) {
    return res.status(400).json({ message: 'Send the question title or body' });
  }

  await streamToSSE(res, {
    effort: 'high',
    maxTokens: 4096,
    system:
      'Draft an answer to the question below, written as a community member replying. ' +
      'Open with the answer itself, then support it. If the question is missing detail ' +
      'you would need, say what you would ask rather than guessing. Do not restate the ' +
      'question back, and do not sign off.',
    prompt: `Question title: ${title}\n\nQuestion body:\n${body || '(no additional detail given)'}`
  });
});

/**
 * POST /api/ai/improve-question
 * Rewrites a vague question into one people can actually answer.
 */
router.post('/improve-question', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title, 300);
    const body = sanitizeText(req.body.body, 4000);

    if (!title && !body) {
      return res.status(400).json({ message: 'Send a draft title or body' });
    }

    const { data } = await completeStructured({
      effort: 'medium',
      maxTokens: 2048,
      system:
        'Rewrite the draft question so it is specific enough to answer. Keep the ' +
        "asker's voice and their actual question — do not substitute a different one. " +
        'The title should read as a question someone would search for.',
      prompt: `Draft title: ${title}\n\nDraft body:\n${body || '(empty)'}`,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Improved title, under 120 characters' },
          body: { type: 'string', description: 'Improved body in markdown' },
          rationale: { type: 'string', description: 'One sentence on what changed and why' }
        },
        required: ['title', 'body', 'rationale'],
        additionalProperties: false
      }
    });

    res.json(data);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/ai/suggest-tags
 * The enum is pinned to the real interest catalog so the model cannot invent
 * a tag that no Space exists for.
 */
router.post('/suggest-tags', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title, 300);
    const body = sanitizeText(req.body.body, 4000);

    if (!title && !body) {
      return res.status(400).json({ message: 'Send a title or body to tag' });
    }

    const vocabulary = INTERESTS.map((i) => i.id);

    const { data } = await completeStructured({
      effort: 'low',
      maxTokens: 512,
      system:
        'Choose the interest areas this question belongs to. Pick only areas the ' +
        'question is genuinely about — two precise tags are better than five loose ones.',
      prompt: `Title: ${title}\n\nBody:\n${body || '(empty)'}`,
      schema: {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string', enum: vocabulary },
            description: 'Between 1 and 4 interest ids'
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Up to 4 free-form topic keywords, lowercase'
          }
        },
        required: ['tags', 'keywords'],
        additionalProperties: false
      }
    });

    // Defence in depth — the schema enum should already guarantee this.
    const tags = (data.tags || []).filter((t) => vocabulary.includes(t)).slice(0, 4);
    res.json({ tags, keywords: (data.keywords || []).slice(0, 4) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/ai/moderate
 * Triage for the admin report queue — a recommendation for a human, not an
 * automatic enforcement action.
 */
router.post('/moderate', async (req, res) => {
  try {
    const content = sanitizeText(req.body.content, 6000);
    const reason = sanitizeText(req.body.reason, 200);

    if (!content) return res.status(400).json({ message: 'Nothing to review' });

    const { data } = await completeStructured({
      effort: 'low',
      maxTokens: 1024,
      system:
        'You are triaging a user report for a human moderator. Judge the reported ' +
        'content itself, not the reporter\'s framing — reports are often wrong or ' +
        'retaliatory. Recommend removal only for content that clearly breaks a rule; ' +
        'rudeness and disagreement are not violations.',
      prompt: `Reported for: ${reason || 'unspecified'}\n\nContent:\n${content}`,
      schema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self-harm', 'misinformation', 'other', 'no-violation']
          },
          severity: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          recommendation: { type: 'string', enum: ['dismiss', 'review', 'remove'] },
          reasoning: { type: 'string', description: 'One or two sentences for the moderator' }
        },
        required: ['category', 'severity', 'recommendation', 'reasoning'],
        additionalProperties: false
      }
    });

    res.json(data);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * POST /api/ai/summarize-thread
 * Condenses a long answer thread for someone arriving late.
 */
router.post('/summarize-thread', async (req, res) => {
  try {
    const title = sanitizeText(req.body.title, 300);
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (!answers.length) return res.status(400).json({ message: 'No answers to summarize' });

    const joined = answers
      .slice(0, 20)
      .map((a, i) => `Answer ${i + 1}:\n${sanitizeText(a, 2000)}`)
      .join('\n\n');

    const { text } = await complete({
      effort: 'medium',
      maxTokens: 1024,
      system:
        'Summarize where this thread landed for someone who has not read it. Lead ' +
        'with the consensus if there is one, then note any substantive disagreement. ' +
        'If the answers conflict and none is clearly better, say so rather than picking.',
      prompt: `Question: ${title}\n\n${joined}`
    });

    res.json({ summary: text });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
