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
    knowledgeSummary: {
      titles: { type: [String], default: [] },
      products: { type: [String], default: [] },
      modules: { type: [String], default: [] },
      topics: { type: [String], default: [] },
      features: { type: [String], default: [] },
      services: { type: [String], default: [] },
      headings: { type: [String], default: [] },
      rawSummary: { type: String, default: "" }
    },
    knowledgeTopics: {
      type: [String],
      default: []
    },
    knowledgeModules: {
      type: [String],
      default: []
    },
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE"
    },
    apiKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true
    },
    secretKey: {
      type: String,
      sparse: true
    },
    keyCreatedAt: {
      type: Date,
      default: Date.now
    },
    keyLastUsedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

botSchema.pre("save", function (next) {
  const crypto = require("crypto");
  if (!this.apiKey) {
    this.apiKey = `bot_pk_${crypto.randomBytes(16).toString("hex")}`;
  }
  if (!this.secretKey) {
    this.secretKey = `bot_sk_${crypto.randomBytes(24).toString("hex")}`;
  }
  if (typeof next === "function") {
    next();
  }
});

module.exports = mongoose.model("Bot", botSchema);
