const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body: { type: String, required: true },
  upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  downvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isAccepted: { type: Boolean, default: false },
  pointsAwarded: { type: Boolean, default: false }, // 5pts for answering
  bonusPointsAwarded: { type: Boolean, default: false } // extra 5pts for 5 upvotes
}, { timestamps: true });

module.exports = mongoose.model('Answer', answerSchema);
