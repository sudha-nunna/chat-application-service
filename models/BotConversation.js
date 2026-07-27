const mongoose = require("mongoose");

const botConversationSchema = new mongoose.Schema(
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
    title: {
      type: String,
      default: "New Bot Conversation"
    },
    conversationSummary: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

botConversationSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotConversation", botConversationSchema);
