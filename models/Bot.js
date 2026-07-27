const mongoose = require("mongoose");

const botSchema = new mongoose.Schema(
  {
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
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: ""
    },
    model: {
      type: String,
      default: "gpt-4o"
    },
    systemPrompt: {
      type: String,
      default: "You are a specialized AI assistant. You answer questions strictly based on the provided knowledge base and integrated APIs."
    },
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE"
    }
  },
  {
    timestamps: true
  }
);

botSchema.index({ userId: 1 });

module.exports = mongoose.model("Bot", botSchema);
