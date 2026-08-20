const mongoose = require("mongoose");

const creditTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true, // Can be positive (grant/purchase) or negative (usage)
    },
    type: {
      type: String,
      enum: ["purchase", "admin_grant", "admin_deduct", "message_sent", "subscription_grant", "other"],
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("CreditTransaction", creditTransactionSchema);
