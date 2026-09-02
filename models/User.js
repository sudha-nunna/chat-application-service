const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
    },

    profilePic: {
      type: String,
      default: "",
    },

    authType: {
      type: String,
      enum: ["google", "local"],
      default: "google",
    },

    password: {
      type: String,
      select: false, // Don't return password by default
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    plan: {
      type: String,
      enum: ["free", "pro", "enterprise"],
      default: "free",
    },

    credits: {
      type: Number,
      default: 100, // 100 free credits on sign up
    },

    isPaidUser: {
      type: Boolean,
      default: false, // Becomes true upon first credit pack purchase
    },

    signupBonusGranted: {
      type: Boolean,
      default: true, // Flag ensuring 100 free signup credits are granted only once
    },

    totalCreditsPurchased: {
      type: Number,
      default: 0,
    },

    activeSubscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },

    avatarImageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MediaAsset",
      default: null,
    },

    avatarUrl: {
      type: String,
      default: "",
    },

    voiceSampleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MediaAsset",
      default: null,
    },

    voiceSampleUrl: {
      type: String,
      default: "",
    },

    botName: {
      type: String,
      default: "",
    },

    isProfileSetup: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.post(["findOneAndDelete", "deleteOne", "remove"], async function(doc) {
  try {
    const userId = doc?._id || this.getQuery()?._id;
    if (userId) {
      const uStr = userId.toString();
      // 1. Delete associated media assets
      const MediaAsset = mongoose.model("MediaAsset");
      if (MediaAsset) {
        await MediaAsset.deleteMany({ userId }).catch(() => {});
      }

      // 2. Invalidate Redis session & purge user caches
      const { redis, delCache } = require("../utils/redisClient");
      if (redis && redis.status === "ready") {
        await redis.set(`user:session:${uStr}`, "0", "EX", 86400).catch(() => {});
        const keys = await redis.keys(`*${uStr}*`).catch(() => []);
        if (keys.length > 0) {
          await redis.del(keys).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error("User deletion cascade hook error:", err);
  }
});

module.exports = mongoose.model("User", userSchema);