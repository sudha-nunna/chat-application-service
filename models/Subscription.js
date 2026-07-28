const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["free", "pro", "enterprise"],
      default: "free",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "canceled", "past_due", "incomplete", "expired", "trialing"],
      default: "active",
      required: true,
    },
    billingCycle: {
      type: String,
      enum: ["none", "monthly", "annual"],
      default: "none",
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    endDate: {
      type: Date,
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    canceledAt: {
      type: Date,
      default: null,
    },
    paymentProvider: {
      type: String,
      enum: ["none", "stripe", "razorpay", "manual"],
      default: "none",
    },
    providerCustomerId: {
      type: String,
      default: null,
    },
    providerSubscriptionId: {
      type: String,
      default: null,
    },
    paymentReference: {
      type: String,
      default: null,
    },
    priorityScore: {
      type: Number,
      default: 10,
    },
  },
  {
    timestamps: true,
  }
);

subscriptionSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model("Subscription", subscriptionSchema);
