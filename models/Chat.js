const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    title: {
      type: String,
      default: "New Chat",
    },

    extractedEntities: {
      firstName: { type: String, default: null },
      lastName: { type: String, default: null },
      email: { type: String, default: null },
      phone: { type: String, default: null },
      companyName: { type: String, default: null },
      description: { type: String, default: null },
      isConfirmed: { type: Boolean, default: false }
    },
    conversationSummary: {
      type: String,
      default: ""
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Chat", chatSchema);