const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Usage = require("../models/Usage");
const Plan = require("../models/Plan");
const CreditTransaction = require("../models/CreditTransaction");
const { calculatePriority } = require("../utils/priorityCalculator");

/**
 * 1. Fetch Current Subscription Details
 * GET /subscription/me
 */
exports.getSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let subscription = null;
    if (user.activeSubscriptionId) {
      subscription = await Subscription.findById(user.activeSubscriptionId);
    }

    // Lazy evaluation of subscription expiration (only for recurring cycles with endDate)
    if (subscription && subscription.billingCycle !== "one-time" && subscription.endDate && new Date() > new Date(subscription.endDate)) {
      if (subscription.status === "active" || subscription.cancelAtPeriodEnd) {
        subscription.status = "expired";
        await subscription.save();

        user.plan = "free";
        user.activeSubscriptionId = null;
        await user.save();
      }
    }

    const priorityScore = await calculatePriority(user.plan, subscription?.status);

    res.json({
      success: true,
      subscription: {
        plan: user.plan,
        status: subscription ? subscription.status : "active",
        billingCycle: subscription ? subscription.billingCycle : "none",
        startDate: subscription ? subscription.startDate : user.createdAt,
        endDate: subscription ? subscription.endDate : null,
        cancelAtPeriodEnd: subscription ? subscription.cancelAtPeriodEnd : false,
        paymentProvider: subscription ? subscription.paymentProvider : "none",
        priorityScore,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. Upgrade / Purchase Credit Package
 * POST /subscription/upgrade
 * Body: { plan: string, billingCycle: "one-time" | "monthly" | "annual", paymentProvider?: string, paymentReference?: string }
 */
exports.upgradePlan = async (req, res) => {
  try {
    const { plan, billingCycle = "one-time", paymentProvider = "manual", paymentReference = null } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const dbPlan = await Plan.findOne({ key: (plan || "").toLowerCase() });

    const now = new Date();
    let endDate = null;
    if (billingCycle === "annual") {
      endDate = new Date();
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else if (billingCycle === "monthly") {
      endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);
    }

    const priority = await calculatePriority(plan, "active");

    const subscription = await Subscription.create({
      userId: user._id,
      plan,
      status: "active",
      billingCycle,
      startDate: now,
      endDate,
      cancelAtPeriodEnd: false,
      paymentProvider,
      paymentReference,
      priorityScore: priority,
    });

    user.plan = plan;
    user.activeSubscriptionId = subscription._id;

    // Grant credits configured on this package
    const creditsToAdd = dbPlan?.creditsGranted || (plan.toLowerCase() === "starter" ? 500 : plan.toLowerCase() === "pro" ? 2500 : plan.toLowerCase() === "power" ? 10000 : 0);
    if (creditsToAdd > 0) {
      const newBalance = parseFloat(((user.credits || 0) + creditsToAdd).toFixed(4));
      user.credits = newBalance;
      user.isPaidUser = true;
      user.totalCreditsPurchased = (user.totalCreditsPurchased || 0) + creditsToAdd;

      await CreditTransaction.create({
        userId: user._id,
        amount: creditsToAdd,
        type: "purchase",
        description: `Purchased ${dbPlan ? dbPlan.name : plan} (+${creditsToAdd.toLocaleString()} credits)`,
        balanceAfter: newBalance,
      }).catch(() => {});
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: `Successfully purchased ${dbPlan ? dbPlan.name : plan} (+${creditsToAdd.toLocaleString()} credits added to your wallet)!`,
      subscription,
      creditsAdded: creditsToAdd,
      newBalance: user.credits,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. Downgrade Plan
 * POST /subscription/downgrade
 * Body: { plan: string }
 */
exports.downgradePlan = async (req, res) => {
  try {
    const { plan } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (user.plan === plan) {
      return res.status(400).json({
        success: false,
        message: `User is already on the ${plan} plan`,
      });
    }

    const priority = await calculatePriority(plan, "active");

    if (plan === "free") {
      if (user.activeSubscriptionId) {
        await Subscription.findByIdAndUpdate(user.activeSubscriptionId, {
          status: "canceled",
          canceledAt: new Date(),
          priorityScore: priority,
        });
      }

      user.plan = "free";
      user.activeSubscriptionId = null;
      await user.save();
    } else {
      const now = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);

      const subscription = await Subscription.create({
        userId: user._id,
        plan,
        status: "active",
        billingCycle: "monthly",
        startDate: now,
        endDate,
        priorityScore: priority,
      });

      user.plan = plan;
      user.activeSubscriptionId = subscription._id;
      await user.save();
    }

    res.json({
      success: true,
      message: `Successfully downgraded to ${plan} plan`,
      user: { id: user._id, email: user.email, plan: user.plan },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 4. Cancel Subscription
 * POST /subscription/cancel
 */
exports.cancelSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user || !user.activeSubscriptionId) {
      return res.status(400).json({
        success: false,
        message: "No active subscription found to cancel",
      });
    }

    const subscription = await Subscription.findById(user.activeSubscriptionId);
    if (!subscription) {
      return res.status(404).json({ success: false, message: "Subscription record not found" });
    }

    subscription.cancelAtPeriodEnd = true;
    subscription.canceledAt = new Date();
    await subscription.save();

    res.json({
      success: true,
      message: "Subscription set to cancel at end of billing cycle",
      accessUntil: subscription.endDate,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 5. Fetch User Usage Statistics
 * GET /subscription/usage
 */
exports.getUsage = async (req, res) => {
  try {
    const userId = req.user.id;
    const todayStr = new Date().toISOString().split("T")[0];

    let usage = await Usage.findOne({ userId, date: todayStr });
    if (!usage) {
      usage = { messagesUsedToday: 0, agentsCreated: 0, fileUploads: 0, apiCalls: 0 };
    }

    res.json({
      success: true,
      usage,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 6. Webhook Integration Handler
 * POST /subscription/webhook
 */
exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    switch (event.type) {
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subData = event.data?.object;
        if (subData) {
          const subscription = await Subscription.findOne({
            providerSubscriptionId: subData.id,
          });

          if (subscription) {
            if (event.type === "customer.subscription.deleted") {
              subscription.status = "canceled";
              await subscription.save();

              await User.findByIdAndUpdate(subscription.userId, {
                plan: "free",
                activeSubscriptionId: null,
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }

    res.status(200).json({ received: true });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
