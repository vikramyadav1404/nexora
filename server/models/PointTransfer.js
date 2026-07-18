const mongoose = require('mongoose');

const pointTransferSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  points: { type: Number, required: true, min: 1 },
  message: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('PointTransfer', pointTransferSchema);
