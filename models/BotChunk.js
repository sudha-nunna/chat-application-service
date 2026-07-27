const mongoose = require("mongoose");

const botChunkSchema = new mongoose.Schema(
  {
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
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotFile",
      required: true,
      index: true
    },
    chunkIndex: {
      type: Number,
      required: true
    },
    text: {
      type: String,
      required: true
    },
    keywords: [
      {
        type: String,
        lowercase: true,
        trim: true
      }
    ]
  },
  {
    timestamps: true
  }
);

botChunkSchema.index({ userId: 1, botId: 1 });
botChunkSchema.index({ botId: 1, text: "text" });

module.exports = mongoose.model("BotChunk", botChunkSchema);
