const User = require("../models/User");
const CreditTransaction = require("../models/CreditTransaction");
const Plan = require("../models/Plan");

/**
 * GET /credits/packs
 * List available credit top-up packages directly from MongoDB Plan collection
 */
exports.getCreditPacks = async (req, res) => {
  try {
    const dbPlans = await Plan.find({ active: true }).sort({ monthlyPrice: 1, priorityScore: 1 });
    const packs = (dbPlans || []).map(p => ({
      id: p.key,
      name: p.name,
      credits: p.creditsGranted || 100,
      price: `$${(p.monthlyPrice || 0).toFixed(2)}`,
      priceUsd: p.monthlyPrice || 0,
      popular: Boolean(p.recommended),
      description: p.description || `${(p.creditsGranted || 100).toLocaleString()} AI Credits Package`,
      features: p.features && p.features.length > 0 ? p.features : [
        `${(p.creditsGranted || 100).toLocaleString()} AI Credits`,
        "Unlocks Paid Tier (No daily message cap)",
        "Priority Cluster Routing",
        "All Online AI Models Included"
      ]
    }));

    return res.json({
      success: true,
      data: packs
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /credits/purchase
 * Purchase / Top up credits based strictly on MongoDB configured Credit Packages
 * Body: { packId: string, paymentMethod?: string }
 */
exports.purchaseCredits = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { packId } = req.body;

    const mongoose = require("mongoose");
    const isObjectId = mongoose.Types.ObjectId.isValid(packId);
    const query = isObjectId ? { _id: packId, active: true } : { key: packId, active: true };

    const dbPlan = await Plan.findOne(query);
    if (!dbPlan) {
      return res.status(400).json({
        success: false,
        message: `Invalid or inactive credit package '${packId}'.`
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User account not found." });
    }

    const creditsToAdd = dbPlan.creditsGranted || 100;
    const newBalance = parseFloat(((user.credits || 0) + creditsToAdd).toFixed(4));

    // Update user balance & paid status
    user.credits = newBalance;
    user.isPaidUser = true;
    user.totalCreditsPurchased = (user.totalCreditsPurchased || 0) + creditsToAdd;
    await user.save();

    // Record credit transaction
    const tx = await CreditTransaction.create({
      userId: user._id,
      amount: creditsToAdd,
      type: "purchase",
      description: `Purchased ${dbPlan.name} (+${creditsToAdd.toLocaleString()} credits)`,
      balanceAfter: newBalance
    });

    return res.status(200).json({
      success: true,
      message: `Successfully added ${creditsToAdd.toLocaleString()} credits to your wallet!`,
      data: {
        creditsAdded: creditsToAdd,
        newBalance: user.credits,
        isPaidUser: true,
        transactionId: tx._id
      }
    });
  } catch (error) {
    console.error("Credit purchase failed:", error);
    return res.status(500).json({ success: false, message: "Credit purchase failed. Please try again." });
  }
};
