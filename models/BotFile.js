const mongoose = require("mongoose");

const botFileSchema = new mongoose.Schema(
  {
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
    fileName: {
      type: String,
      required: true
    },
    fileType: {
      type: String,
      enum: ["pdf", "txt", "docx", "md"],
      required: true
    },
    fileSize: {
      type: Number,
      default: 0
    },
    originalContent: {
      type: String,
      default: ""
    },
    parsedText: {
      type: String,
      required: true
    },
    fileCategory: {
      type: String,
      enum: ["knowledge", "rules"],
      default: "knowledge"
    },
    chunkCount: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

botFileSchema.index({ userId: 1, botId: 1 });

module.exports = mongoose.model("BotFile", botFileSchema);
