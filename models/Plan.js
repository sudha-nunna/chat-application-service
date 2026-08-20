const mongoose = require("mongoose");

const planSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    monthlyPrice: {
      type: Number,
      default: 0,
    },
    annualPrice: {
      type: Number,
      default: 0,
    },
    creditsGranted: {
      type: Number,
      default: 0, // Number of credits granted per month
    },
    priorityScore: {
      type: Number,
      default: 10,
    },
    maxAgents: {
      type: Number,
      default: 1, // -1 means unlimited
    },
    maxMessagesPerDay: {
      type: Number,
      default: 50, // -1 means unlimited
    },
    maxKnowledgeFiles: {
      type: Number,
      default: 2, // -1 means unlimited
    },
    maxApiIntegrations: {
      type: Number,
      default: 0, // -1 means unlimited
    },
    features: [
      {
        type: String,
      },
    ],
    recommended: {
      type: Boolean,
      default: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Plan", planSchema);
