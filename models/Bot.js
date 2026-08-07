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
    botMode: {
      type: String,
      enum: ["small", "medium", "large"],
      default: "small",
      lowercase: true
    },
    allowedDomains: {
      type: [String],
      default: []
    },
    systemPrompt: {
      type: String,
      default: "You are a specialized AI assistant. You answer questions strictly based on the provided knowledge base and integrated APIs."
    },
    rulesConfig: {
      manualRulesText: { type: String, default: "" },
      rulesText: { type: String, default: "" },
      rulesCount: { type: Number, default: 0 },
      wantsScheduleCard: { type: Boolean, default: false },
      rulesList: { type: [String], default: [] },
      sourceFiles: { type: [String], default: [] }
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
      type: Date
    },
    keyLastUsedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("Bot", botSchema);
