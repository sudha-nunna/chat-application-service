const mongoose = require("mongoose");

const ServerNodeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    url: {
      type: String,
      required: true,
      trim: true
    },
    defaultModel: {
      type: String,
      default: "llama3.2:3b",
      trim: true
    },
    format: {
      type: String,
      enum: ["openai", "ollama", "gemini"],
      default: "openai"
    },
    secretKey: {
      type: String,
      default: "",
      trim: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    priority: {
      type: Number,
      default: 10,
      min: 1,
      max: 100
    },
    status: {
      type: String,
      default: "HEALTHY"
    },
    lastLatencyMs: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ServerNode", ServerNodeSchema);
