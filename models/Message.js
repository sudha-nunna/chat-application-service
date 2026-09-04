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

    attachments: [
      {
        name: { type: String, required: true },
        fileType: { type: String, enum: ["image", "pdf", "txt"], required: true },
        mimeType: { type: String, required: true },
        data: { type: String },
        size: { type: Number },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Message", messageSchema);