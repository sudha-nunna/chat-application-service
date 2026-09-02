const User = require("../models/User");
const Usage = require("../models/Usage");
const Plan = require("../models/Plan");
const ModelUsage = require("../models/ModelUsage");
const CreditTransaction = require("../models/CreditTransaction");
const AIModel = require("../models/AIModel");

/**
 * GET /api/usage/summary
 * Returns the current user's usage metrics, plan limits, today's usage, model breakdown, and recent transactions.
 */
exports.getUserUsageSummary = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;

    // 1. Fetch user doc & plan
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const isPaid = Boolean(user.isPaidUser || user.totalCreditsPurchased > 0);
    const planKey = isPaid ? "paid" : "free";

    // 2. Fetch today's usage
    const todayStr = new Date().toISOString().split("T")[0];
    const todayUsage = (await Usage.findOne({ userId, date: todayStr }).lean()) || {
      messagesUsedToday: 0,
      tokensUsedToday: 0,
      creditsUsedToday: 0
    };

    // 3. Fetch past 7 days usage history
    const past7Days = await Usage.find({ userId })
      .sort({ date: -1 })
      .limit(7)
      .lean();

    // 4. Model usage breakdown (aggregated credits and tokens per model)
    const modelStats = await ModelUsage.aggregate([
      { $match: { userId: user._id } },
      {
        $group: {
          _id: "$modelId",
          totalRequests: { $sum: 1 },
          totalCreditsUsed: { $sum: "$creditsUsed" },
          totalPromptTokens: { $sum: "$promptTokens" },
          totalCompletionTokens: { $sum: "$completionTokens" },
          avgResponseTimeMs: { $avg: "$responseTimeMs" }
        }
      },
      { $sort: { totalCreditsUsed: -1 } }
    ]);

    // 5. Recent credit/token transactions (last 10)
    const recentTransactions = await CreditTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    // 6. Calculate total lifetime tokens & credits used
    let totalLifetimeTokens = 0;
    let totalLifetimeCreditsUsed = 0;
    modelStats.forEach((m) => {
      totalLifetimeTokens += (m.totalPromptTokens || 0) + (m.totalCompletionTokens || 0);
      totalLifetimeCreditsUsed += m.totalCreditsUsed || 0;
    });

    return res.json({
      success: true,
      data: {
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          credits: typeof user.credits === "number" ? parseFloat(user.credits.toFixed(4)) : 0,
          isPaidUser: isPaid,
          plan: isPaid ? "Paid Tier" : "Free Tier"
        },
        plan: {
          key: planKey,
          name: isPaid ? "PAID (UNLIMITED)" : "FREE TIER",
          maxMessagesPerDay: isPaid ? -1 : 50,
          isPaidUser: isPaid
        },
        today: {
          date: todayStr,
          messagesUsed: todayUsage.messagesUsedToday || 0,
          tokensUsed: todayUsage.tokensUsedToday || 0,
          creditsUsed: parseFloat((todayUsage.creditsUsedToday || 0).toFixed(4)),
          messagesRemaining: isPaid ? "Unlimited" : Math.max(0, 50 - (todayUsage.messagesUsedToday || 0))
        },
        lifetime: {
          totalTokens: totalLifetimeTokens,
          totalCreditsUsed: parseFloat(totalLifetimeCreditsUsed.toFixed(4)),
          totalRequests: modelStats.reduce((acc, curr) => acc + curr.totalRequests, 0)
        },
        modelBreakdown: modelStats.map((item) => ({
          modelId: item._id,
          totalRequests: item.totalRequests,
          creditsUsed: parseFloat(item.totalCreditsUsed.toFixed(4)),
          promptTokens: item.totalPromptTokens,
          completionTokens: item.totalCompletionTokens,
          totalTokens: (item.totalPromptTokens || 0) + (item.totalCompletionTokens || 0),
          avgLatencyMs: Math.round(item.avgResponseTimeMs || 0)
        })),
        recentHistory: past7Days.reverse(),
        recentTransactions
      }
    });
  } catch (error) {
    console.error("Error fetching user usage summary:", error);
    return res.status(500).json({ success: false, error: "Failed to load usage summary." });
  }
};
