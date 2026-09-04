const mongoose = require("mongoose");

const promoOfferSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    offerMode: {
      type: String,
      enum: ["BONUS", "OVERRIDE"],
      default: "BONUS",
      required: true
    },
    creditValue: {
      type: Number,
      required: true,
      min: 0
    },
    startDate: {
      type: Date,
      required: true
    },
    endDate: {
      type: Date,
      required: true
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model("PromoOffer", promoOfferSchema);
