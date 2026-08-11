const mongoose = require("mongoose");

const avatarConversationSchema = new mongoose.Schema(
  {
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      required: false,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true
    },
    title: {
      type: String,
      default: "Avatar AI Conversation"
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

avatarConversationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("AvatarConversation", avatarConversationSchema);
