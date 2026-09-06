const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },

    content: {
      type: String,
      required: true,
    },

    isStoppedMidway: {
      type: Boolean,
      default: false,
    },

    attachments: [
      {
        name: { type: String, required: true },
        fileType: { type: String, enum: ["image", "pdf", "txt"], required: true },
        mimeType: { type: String, required: true },
        data: { type: String },
        size: { type: Number },
      },
    ],

    sources: [
      {
        id: { type: Number },
        title: { type: String },
        url: { type: String },
        domain: { type: String },
        snippet: { type: String }
      }
    ],
    requiresWebSearch: {
      type: Boolean,
      default: false
    },
    followUps: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Message", messageSchema);