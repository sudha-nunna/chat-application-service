const mongoose = require("mongoose");
const { Schema } = mongoose;

const NotificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true }, // e.g. "daily_news", "market_update", "mcp_alert"
    sourceType: { type: String, default: "custom_query" },
    category: { type: String, default: "intelligence" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
  },
  { timestamps: true }
);

// Compound indexes for fast paginated queries and unread lookups
NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });

// 10-Day Automatic MongoDB TTL Cleanup Index (10 days = 864,000 seconds)
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 864000 });

module.exports = mongoose.model("Notification", NotificationSchema);
