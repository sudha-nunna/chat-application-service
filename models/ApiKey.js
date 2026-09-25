const mongoose = require("mongoose");

const apiKeySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },
    keyPrefix: {
      type: String,
      required: true,
      index: true
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    status: {
      type: String,
      enum: ["ACTIVE", "REVOKED"],
      default: "ACTIVE",
      index: true
    },
    rateLimitRPM: {
      type: Number,
      default: 60
    },
    lastUsedAt: { type: Date, default: null },
    totalRequests: { type: Number, default: 0 },
    totalTokensUsed: { type: Number, default: 0 },
    totalCreditsSpent: { type: Number, default: 0 }
  },
  { timestamps: true }
);

apiKeySchema.index({ keyHash: 1, status: 1 });

module.exports = mongoose.model("ApiKey", apiKeySchema);
