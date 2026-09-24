const mongoose = require("mongoose");
const { Schema } = mongoose;

const NotificationPreferenceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    marketUpdates: { type: Boolean, default: true },
    newsSummaries: { type: Boolean, default: true },
    mcpAlerts: { type: Boolean, default: true },
    creditAlerts: { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NotificationPreference", NotificationPreferenceSchema);
