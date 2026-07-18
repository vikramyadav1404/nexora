const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true },
  tags: [{ type: String, lowercase: true, trim: true }],
  upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  downvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  views: { type: Number, default: 0 },
  answers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Answer' }],
  acceptedAnswer: { type: mongoose.Schema.Types.ObjectId, ref: 'Answer', default: null },
  isResolved: { type: Boolean, default: false },
  bounty: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Question', questionSchema);
