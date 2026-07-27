const mongoose = require("mongoose");

const botApiSchema = new mongoose.Schema(
  {
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      required: true,
      index: true
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true
    },
    url: {
      type: String,
      required: true
    },
    method: {
      type: String,
      enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      default: "GET"
    },
    headers: {
      type: Map,
      of: String,
      default: {}
    },
    authType: {
      type: String,
      enum: ["none", "apiKey", "bearerToken"],
      default: "none"
    },
    encryptedApiKey: {
      type: String,
      default: null
    },
    encryptedBearerToken: {
      type: String,
      default: null
    },
    requestMapping: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

botApiSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotApi", botApiSchema);
