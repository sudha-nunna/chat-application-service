const mongoose = require("mongoose");

const systemSettingSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "global_settings",
      unique: true,
      index: true
    },
    welcomeCredits: {
      type: Number,
      default: 100,
      min: 0
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("SystemSetting", systemSettingSchema);
