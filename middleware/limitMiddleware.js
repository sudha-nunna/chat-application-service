const User = require("../models/User");
const Plan = require("../models/Plan");
const Usage = require("../models/Usage");
const Bot = require("../models/Bot");

/**
 * Gets today's date string YYYY-MM-DD
 */
const getTodayString = () => {
  return new Date().toISOString().split("T")[0];
};

/**
 * Middleware: Enforces Daily Chat Message Limits based on user's plan.
 */
const checkMessageLimit = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const plan = await Plan.findOne({ key: user.plan, active: true });
    const maxMessages = plan ? plan.maxMessagesPerDay : 50;

    // -1 represents unlimited messages
    if (maxMessages === -1) {
      return next();
    }

    const todayStr = getTodayString();
    let usage = await Usage.findOne({ userId: user._id, date: todayStr });

    if (!usage) {
      usage = await Usage.create({ userId: user._id, date: todayStr });
    }

    if (usage.messagesUsedToday >= maxMessages) {
      return res.status(429).json({
        success: false,
        message: `Daily message limit reached (${maxMessages} messages/day). Please upgrade your plan to send more messages.`,
        limitExceeded: true,
        currentUsage: usage.messagesUsedToday,
        maxLimit: maxMessages,
      });
    }

    // Increment message usage counter
    usage.messagesUsedToday += 1;
    await usage.save();

    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Middleware: Enforces Agent Creation Limits based on user's plan.
 */
const checkAgentLimit = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const plan = await Plan.findOne({ key: user.plan, active: true });
    const maxAgents = plan ? plan.maxAgents : 1;

    // -1 represents unlimited agents
    if (maxAgents === -1) {
      return next();
    }

    // Count user's current active bots
    const currentAgentCount = await Bot.countDocuments({ ownerId: user._id });

    if (currentAgentCount >= maxAgents) {
      return res.status(403).json({
        success: false,
        message: `Agent limit reached (${currentAgentCount}/${maxAgents} agents created). Upgrade to Pro or Enterprise to create more AI agents.`,
        limitExceeded: true,
        currentUsage: currentAgentCount,
        maxLimit: maxAgents,
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  checkMessageLimit,
  checkAgentLimit,
};
