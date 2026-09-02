const mongoose = require("mongoose");

const modelUsageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    modelId: {
      type: String,
      required: true,
      index: true
    },
    provider: {
      type: String,
      default: "auto",
      index: true
    },
    nodeId: {
      type: String,
      default: ""
    },
    nodeName: {
      type: String,
      default: ""
    },
    responseTimeMs: {
      type: Number,
      default: 0
    },
    ttftMs: {
      type: Number,
      default: 0
    },
    creditsUsed: {
      type: Number,
      default: 0
    },
    promptTokens: {
      type: Number,
      default: 0
    },
    completionTokens: {
      type: Number,
      default: 0
    },
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED"],
      default: "SUCCESS",
      index: true
    },
    errorMessage: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

modelUsageSchema.index({ userId: 1, createdAt: -1 });
modelUsageSchema.index({ modelId: 1, createdAt: -1 });

module.exports = mongoose.model("ModelUsage", modelUsageSchema);
