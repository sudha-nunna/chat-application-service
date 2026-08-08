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
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      default: null,
      index: true
    },
    botType: {
      type: String,
      enum: ["CHAT", "ACTION", "VOICE", "AVATAR", "HYBRID"],
      default: "HYBRID"
    },
    capabilities: {
      enableRag: { type: Boolean, default: true },
      enableActions: { type: Boolean, default: true },
      enableVoice: { type: Boolean, default: true },
      enableAvatar: { type: Boolean, default: true }
    },
    avatarImage: {
      type: String,
      default: ""
    },
    avatarVideo: {
      type: String,
      default: ""
    },
    avatarProvider: {
      type: String,
      default: "LOCAL_VISEME"
    },
    voiceProfile: {
      voiceId: { type: String, default: "default-en" },
      sampleAudioUrl: { type: String, default: "" },
      voiceType: { type: String, default: "PRESET" }
    },
    avatarConfig: {
      type: Object,
      default: {}
    },
    responseMode: {
      type: String,
      enum: ["TEXT_ONLY", "AUDIO_ONLY", "VIDEO_AVATAR", "HYBRID"],
      default: "HYBRID"
    },
    botSpecificRules: {
      type: String,
      default: ""
    },
    voiceConfig: {
      voiceId: { type: String, default: "default-en" },
      sampleAudioUrl: { type: String, default: "" },
      voiceType: { type: String, default: "PRESET" }
    },
    mcpConfig: {
      enabled: { type: Boolean, default: false },
      servers: { type: Array, default: [] }
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
