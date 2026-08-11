const mongoose = require("mongoose");

const avatarMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AvatarConversation",
      required: true,
      index: true
    },
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
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    avatarMetadata: {
      state: String,
      expression: String,
      animation: String,
      visemes: Array,
      movements: Object
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

avatarMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model("AvatarMessage", avatarMessageSchema);
