const mongoose = require("mongoose");

const userMcpTokenSchema = new mongoose.Schema(
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
      enum: ["slack", "github", "drive", "jira", "postgres"],
      index: true,
    },
    teamId: {
      type: String,
      default: "",
    },
    teamName: {
      type: String,
      default: "",
    },
    userSlackId: {
      type: String,
      default: "",
    },
    encryptedAccessToken: {
      type: String,
      required: true,
    },
    encryptedUserAccessToken: {
      type: String,
      default: "",
    },
    encryptedRefreshToken: {
      type: String,
      default: "",
    },
    scope: {
      type: String,
      default: "",
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

userMcpTokenSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model("UserMcpToken", userMcpTokenSchema);
