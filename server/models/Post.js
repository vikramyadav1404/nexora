const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now }
});

const postSchema = new mongoose.Schema({
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  content: { type: String, trim: true },
  media: [{
    type: { type: String, enum: ['image', 'video'] },
    url: { type: String }
  }],
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: [commentSchema],
  shares: { type: Number, default: 0 },
  isPublic: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Post', postSchema);
