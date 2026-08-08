const mongoose = require("mongoose");

const botEmbeddingSchema = new mongoose.Schema(
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
      required: false,
      default: null,
      index: true
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: false,
      default: null,
      index: true
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotFile",
      required: true,
      index: true
    },
    chunkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotChunk",
      required: true,
      index: true
    },
    text: {
      type: String,
      required: true
    },
    embedding: [
      {
        type: Number
      }
    ]
  },
  {
    timestamps: true
  }
);

botEmbeddingSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotEmbedding", botEmbeddingSchema);
