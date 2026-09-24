const mongoose = require("mongoose");
const { Schema } = mongoose;

const IntelligenceScheduleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    rawPrompt: { type: String, required: true, trim: true },
    normalizedTopic: { type: String, required: true, trim: true, index: true },
    sourceType: {
      type: String,
      enum: ["market_data", "news_summary", "mcp", "custom_query", "workflow"],
      default: "custom_query",
      required: true,
    },
    sourceConfig: { type: Schema.Types.Mixed, default: {} },
    rate: { type: String, default: "daily" },
    timezone: { type: String, required: true, default: "Asia/Kolkata" },
    scheduledTime: { type: String, required: true }, // 24-hr format "09:00"

    // Dual-Timestamp Strategy for 2-Minute Pre-Generation Buffer
    nextGenerateAt: { type: Date, required: true },
    nextRunAt: { type: Date, required: true },
    lastSentAt: { type: Date },

    // Staggered Generation Lifecycle State
    generationStatus: {
      type: String,
      enum: ["pending", "generating", "completed", "failed"],
      default: "pending",
    },

    enabled: { type: Boolean, default: true },
    autoPaused: { type: Boolean, default: false }, // Set to true if user inactive >60 days

    // Observability & Operational Metrics
    executionCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastExecutionAt: { type: Date },
    lastExecutionStatus: {
      type: String,
      enum: ["success", "failed", "cached", "skipped"],
    },
    lastError: { type: String },
    averageExecutionTime: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// High-Performance Production Compound Indexes for <1ms Scheduler Lookups
IntelligenceScheduleSchema.index({ enabled: 1, autoPaused: 1, generationStatus: 1, nextGenerateAt: 1 });
IntelligenceScheduleSchema.index({ enabled: 1, autoPaused: 1, nextRunAt: 1 });
IntelligenceScheduleSchema.index({ userId: 1, normalizedTopic: 1 });
IntelligenceScheduleSchema.index({ normalizedTopic: 1, sourceType: 1 });

module.exports = mongoose.model("IntelligenceSchedule", IntelligenceScheduleSchema);
