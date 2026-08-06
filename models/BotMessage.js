const mongoose = require("mongoose");

const botMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotConversation",
      required: true,
      index: true
    },
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    sources: [
      {
        fileName: String,
        snippet: String
      }
    ]
  },
  {
    timestamps: true
  }
);

botMessageSchema.index({ userId: 1, botId: 1 });
botMessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model("BotMessage", botMessageSchema);
