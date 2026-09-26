const mongoose = require("mongoose");

const snapshotAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    fileType: { type: String, enum: ["image", "pdf", "txt"], required: true },
    mimeType: { type: String, required: true },
    data: { type: String },
    size: { type: Number },
  },
  { _id: false }
);

const snapshotSourceSchema = new mongoose.Schema(
  {
    id: { type: Number },
    title: { type: String },
    url: { type: String },
    domain: { type: String },
    snippet: { type: String },
  },
  { _id: false }
);

const snapshotMessageSchema = new mongoose.Schema(
  {
    originalMessageId: { type: mongoose.Schema.Types.ObjectId },
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    isStoppedMidway: {
      type: Boolean,
      default: false,
    },
    continuationResolved: {
      type: Boolean,
      default: false,
    },
    attachments: [snapshotAttachmentSchema],
    sources: [snapshotSourceSchema],
    requiresWebSearch: {
      type: Boolean,
      default: false,
    },
    followUps: {
      type: [String],
      default: [],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const sharedConversationSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      default: "Shared Conversation",
    },
    conversationSummary: {
      type: String,
      default: "",
    },
    snapshotMessages: [snapshotMessageSchema],
    sharedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// High-performance compound index for lookups by chatId and sharedAt
sharedConversationSchema.index({ chatId: 1, sharedAt: -1 });

module.exports = mongoose.model("SharedConversation", sharedConversationSchema);
