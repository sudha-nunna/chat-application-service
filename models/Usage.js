const mongoose = require("mongoose");

const usageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    date: {
      type: String, // YYYY-MM-DD format for daily aggregation
      required: true,
    },
    messagesUsedToday: {
      type: Number,
      default: 0,
    },
    agentsCreated: {
      type: Number,
      default: 0,
    },
    fileUploads: {
      type: Number,
      default: 0,
    },
    apiCalls: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

usageSchema.index({ userId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("Usage", usageSchema);
