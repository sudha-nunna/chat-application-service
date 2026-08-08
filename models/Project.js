const mongoose = require("mongoose");

const projectSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: ""
    },
    commonBrandRules: {
      type: String,
      default: ""
    },
    allowedDomains: {
      type: [String],
      default: []
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("Project", projectSchema);
