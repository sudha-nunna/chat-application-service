const mongoose = require("mongoose");

const SummarySchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
      unique: true, 
      index: true,
    },
    summarizedContent: {
      type: String,
      required: true,
    },
    lastUpdatedMessageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      required: true,
    },
  },
{
  timestamps:true,
  versionKey: false 
}
);

module.exports = mongoose.model("Summary", SummarySchema);