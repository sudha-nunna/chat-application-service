const mongoose = require("mongoose");

const botContactSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      required: true,
      index: true
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotConversation",
      index: true
    },
    firstName: {
      type: String,
      required: true
    },
    lastName: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      index: true
    },
    phone: {
      type: String,
      required: true
    },
    companyName: {
      type: String,
      default: null
    },
    crmContactId: {
      type: String,
      default: null
    },
    crmSyncStatus: {
      type: String,
      enum: ["PENDING", "SUCCESS", "FAILED"],
      default: "PENDING"
    },
    crmSyncedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

botContactSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotContact", botContactSchema);
