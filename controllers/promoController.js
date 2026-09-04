const PromoOffer = require("../models/PromoOffer");
const SystemSetting = require("../models/SystemSetting");

/**
 * Public Endpoint: Get currently active promotional offer & banner info
 * GET /offers/active
 */
exports.getActiveOffer = async (req, res) => {
  try {
    // 1. Fetch global welcome credits
    let setting = await SystemSetting.findOne({ key: "global_settings" });
    const welcomeCredits = setting && typeof setting.welcomeCredits === "number" ? setting.welcomeCredits : 100;

    // 2. Fetch active promo offers matching current date
    const now = new Date();
    const activeOffers = await PromoOffer.find({
      isActive: true,
      startDate: { $lte: now },
      endDate: { $gte: now }
    }).sort({ createdAt: -1 });

    if (!activeOffers || activeOffers.length === 0) {
      return res.json({
        success: true,
        hasActiveOffer: false,
        welcomeCredits,
        effectiveSignupCredits: welcomeCredits,
        offer: null
      });
    }

    const offer = activeOffers[0];
    let effectiveSignupCredits = welcomeCredits;
    if (offer.offerMode === "BONUS") {
      effectiveSignupCredits = welcomeCredits + (offer.creditValue || 0);
    } else if (offer.offerMode === "OVERRIDE") {
      effectiveSignupCredits = offer.creditValue || welcomeCredits;
    }

    // Calculate time remaining
    const diffMs = new Date(offer.endDate).getTime() - now.getTime();
    const totalMinutes = Math.max(0, Math.floor(diffMs / (1000 * 60)));
    const days = Math.floor(totalMinutes / (60 * 24));
    const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
    const minutes = totalMinutes % 60;

    let timeRemainingText = "";
    if (days > 0) {
      timeRemainingText = `${days} Day${days > 1 ? "s" : ""} ${hours} Hour${hours !== 1 ? "s" : ""}`;
    } else if (hours > 0) {
      timeRemainingText = `${hours} Hour${hours > 1 ? "s" : ""} ${minutes} Min${minutes !== 1 ? "s" : ""}`;
    } else {
      timeRemainingText = `${minutes} Min${minutes !== 1 ? "s" : ""}`;
    }

    const bannerText = `🎉 Limited Time Offer! Register today and get ${effectiveSignupCredits} FREE Credits. Offer Ends In: ${timeRemainingText}`;

    return res.json({
      success: true,
      hasActiveOffer: true,
      welcomeCredits,
      effectiveSignupCredits,
      bannerText,
      timeRemainingText,
      timeRemaining: { days, hours, minutes, totalMinutes },
      offer: {
        _id: offer._id,
        title: offer.title,
        offerMode: offer.offerMode,
        creditValue: offer.creditValue,
        startDate: offer.startDate,
        endDate: offer.endDate,
        isActive: offer.isActive
      }
    });
  } catch (error) {
    console.error("Error fetching active promo offer:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch active promotional offer." });
  }
};
