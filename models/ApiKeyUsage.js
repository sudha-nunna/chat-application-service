const mongoose = require("mongoose");

const apiKeyUsageSchema = new mongoose.Schema(
  {
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ApiKey",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    date: {
      type: String,
      required: true,
      index: true
    }, // Format: "YYYY-MM-DD"
    requestCount: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    creditsDeducted: { type: Number, default: 0 }
  },
  { timestamps: true }
);

apiKeyUsageSchema.index({ apiKeyId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("ApiKeyUsage", apiKeyUsageSchema);
