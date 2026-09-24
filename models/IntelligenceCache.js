const mongoose = require("mongoose");
const { Schema } = mongoose;

const IntelligenceCacheSchema = new Schema(
  {
    normalizedTopic: { type: String, required: true, trim: true, index: true },
    sourceType: { type: String, required: true, trim: true },
    content: { type: Schema.Types.Mixed, required: true },
    ttlMinutes: { type: Number, default: 14400 }, // Default 10 Days (14,400 mins)
    generatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Unique compound index on topic + source to ensure single cached generation per topic
IntelligenceCacheSchema.index({ normalizedTopic: 1, sourceType: 1 }, { unique: true });

// 10-Day Native MongoDB Automatic TTL Cleanup Index
IntelligenceCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("IntelligenceCache", IntelligenceCacheSchema);
