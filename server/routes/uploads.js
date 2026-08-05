const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { sendError } = require('../utils/respond');
const { mediaColumnsAvailable } = require('../db/helpers');
const {
  configFor,
  isAllowedMime,
  createUploadTicket,
  ALLOWED_MIME
} = require('../utils/mediaStorage');

const KINDS = ['avatar', 'cover'];

/**
 * Without migration 008 there is nowhere to record the key, so an upload would
 * succeed and then be orphaned. Refusing at presign is the honest failure:
 * nothing is written to storage and the client shows a real message.
 */
function requireMediaSchema(req, res, next) {
  if (!mediaColumnsAvailable()) {
    return res.status(503).json({
      message: 'Image uploads are not enabled on this server yet.'
    });
  }
  next();
}

/**
 * POST /api/uploads/presign
 *
 * Hands back a short-lived URL the browser can PUT a single object to. Nothing
 * is recorded anywhere yet — an unused ticket just expires, and the object it
 * would have written is swept by the daily cron if the client dies mid-upload.
 *
 * Body: { kind: 'avatar' | 'cover', mimeType, size }
 */
router.post('/presign', protect, requireMediaSchema, uploadLimiter, async (req, res) => {
  try {
    const kind = String(req.body?.kind || '').toLowerCase();
    const mimeType = String(req.body?.mimeType || '').toLowerCase().trim();
    const size = Number(req.body?.size);

    if (!KINDS.includes(kind)) {
      return res.status(400).json({ message: `kind must be one of: ${KINDS.join(', ')}` });
    }

    if (!isAllowedMime(mimeType)) {
      return res.status(400).json({
        message: `Unsupported image type. Use ${Object.keys(ALLOWED_MIME).join(', ')}.`
      });
    }

    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ message: 'A positive size is required' });
    }

    const { maxBytes } = configFor(kind);
    if (size > maxBytes) {
      return res.status(413).json({
        message: `That ${kind} is too large. Maximum is ${Math.round(maxBytes / 1024 / 1024)}MB.`
      });
    }

    // The declared size above is a courtesy check so the browser fails fast on
    // an obviously oversized file. It is not trusted — PATCH re-reads the real
    // size from storage before saving anything.
    const ticket = await createUploadTicket({
      userId: req.user.id,
      kind,
      mimeType
    });

    res.json({
      key: ticket.key,
      bucket: ticket.bucket,
      signedUrl: ticket.signedUrl,
      token: ticket.token,
      expiresIn: ticket.expiresIn,
      contentType: mimeType
    });
  } catch (err) { sendError(res, err, req, 'Could not start that upload'); }
});

module.exports = router;
