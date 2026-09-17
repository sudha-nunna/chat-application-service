const mongoose = require("mongoose");

const mcpAuditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
    },
    toolName: {
      type: String,
      required: true,
    },
    arguments: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED", "BLOCKED"],
      required: true,
    },
    executionTimeMs: {
      type: Number,
      default: 0,
    },
    error: {
      type: String,
      default: "",
    },
    responseSummary: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("McpAuditLog", mcpAuditLogSchema);
