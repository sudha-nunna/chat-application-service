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
    description: {
      type: String,
      default: ""
    },
    baseUrl: {
      type: String,
      default: ""
    },
    endpoint: {
      type: String,
      default: ""
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
    actionType: {
      type: String,
      enum: [
        "CREATE_CONTACT",
        "UPDATE_CONTACT",
        "DELETE_CONTACT",
        "SEARCH_CONTACT",
        "CREATE_TICKET",
        "UPDATE_TICKET",
        "CREATE_LEAD",
        "UPDATE_LEAD",
        "GENERIC"
      ],
      default: "GENERIC"
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
    requestSchema: {
      type: Object,
      default: {}
    },
    responseSchema: {
      type: Object,
      default: {}
    },
    enabled: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

botApiSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotApi", botApiSchema);
