const mongoose = require("mongoose");

const aiModelSchema = new mongoose.Schema(
  {
    modelId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    displayName: {
      type: String,
      required: true,
      trim: true
    },
    provider: {
      type: String,
      enum: ["gemini", "ollama", "glm", "openai", "custom"],
      required: true,
      lowercase: true,
      index: true
    },
    tier: {
      type: String,
      enum: ["FAST", "BALANCED", "HEAVY"],
      default: "BALANCED",
      uppercase: true,
      index: true
    },
    creditCost: {
      type: Number,
      default: 1,
      min: 0
    },
    minCreditCost: {
      type: Number,
      default: 1,
      min: 0
    },
    promptTokenCostPer1k: {
      type: Number,
      default: 0.1,
      min: 0
    },
    completionTokenCostPer1k: {
      type: Number,
      default: 0.2,
      min: 0
    },
    maxTokenLimit: {
      type: Number,
      default: 4096
    },
    contextLength: {
      type: String,
      default: "128k"
    },
    enabled: {
      type: Boolean,
      default: true,
      index: true
    },
    recommended: {
      type: Boolean,
      default: false
    },
    fallbackModels: {
      type: [String],
      default: []
    },
    description: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("AIModel", aiModelSchema);

