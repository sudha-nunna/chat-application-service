const mongoose = require("mongoose");

const ProjectMemorySchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  files: [
    {
      path: { type: String, required: true },
      content: { type: String },
      language: { type: String },
      history: [{ content: String, timestamp: Number }],
      isEntry: { type: Boolean, default: false }
    }
  ],
  manifest: {
    framework: { type: String, default: "react" },
    bundler: { type: String, default: "vite" },
    language: { type: String, default: "javascript" }
  },
  lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model("ProjectMemory", ProjectMemorySchema);
