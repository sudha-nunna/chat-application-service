const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Usage = require("../models/Usage");
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

    // Lazy evaluation of subscription expiration
    if (subscription && subscription.endDate && new Date() > new Date(subscription.endDate)) {
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
 * 2. Upgrade Plan
 * POST /subscription/upgrade
 * Body: { plan: string, billingCycle: "monthly" | "annual", paymentProvider?: string, paymentReference?: string }
 */
exports.upgradePlan = async (req, res) => {
  try {
    const { plan, billingCycle = "monthly", paymentProvider = "manual", paymentReference = null } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const now = new Date();
    const endDate = new Date();
    if (billingCycle === "annual") {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
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
    await user.save();

    res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${plan} plan`,
      subscription,
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
