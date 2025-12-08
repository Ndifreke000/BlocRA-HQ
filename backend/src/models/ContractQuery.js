const mongoose = require('mongoose');

const contractQuerySchema = new mongoose.Schema({
  contracts: [{
    address: { type: String, required: true },
    name: String
  }],
  chain: { type: String, required: true },
  fromDate: Date,
  toDate: Date,
  events: [mongoose.Schema.Types.Mixed],
  stats: mongoose.Schema.Types.Mixed,
  contractInfo: mongoose.Schema.Types.Mixed,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ContractQuery', contractQuerySchema);
