const mongoose = require("mongoose");

const mcpServerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    provider: {
      type: String,
      required: true,
      enum: ["slack", "github", "drive", "jira", "postgres", "custom"],
    },
    type: {
      type: String,
      required: true,
      enum: ["STDIO", "SSE"],
      default: "STDIO",
    },
    command: {
      type: String,
      default: "",
    },
    args: {
      type: [String],
      default: [],
    },
    url: {
      type: String,
      default: "",
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    hitlPolicy: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "DEGRADED", "OFFLINE"],
      default: "ACTIVE",
    },
    lastHealthCheck: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("McpServer", mcpServerSchema);
