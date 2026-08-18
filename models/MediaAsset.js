const mongoose = require("mongoose");

const mediaAssetSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true
    },
    contentType: {
      type: String,
      required: true
    },
    data: {
      type: Buffer,
      required: true
    },
    size: {
      type: Number,
      default: 0
    },
    type: {
      type: String,
      enum: ["AVATAR_IMAGE", "PROFILE_IMAGE", "AVATAR_3D_MODEL", "AVATAR_VIDEO", "SPEECH_AUDIO", "VOICE_SAMPLE", "OTHER"],
      default: "OTHER"
    },
    botId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bot",
      default: null,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    isSelected: {
      type: Boolean,
      default: false
    },
    isTransient: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

mediaAssetSchema.index({ userId: 1, type: 1, createdAt: -1 });
mediaAssetSchema.index({ userId: 1, isSelected: 1 });

module.exports = mongoose.model("MediaAsset", mediaAssetSchema);
