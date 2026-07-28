const Plan = require("../models/Plan");

/**
 * Default fallback priority scores
 */
const DEFAULT_PRIORITY_MAP = {
  free: 10,
  pro: 50,
  enterprise: 100,
};

/**
 * Calculates quantitative priority score dynamically from the Plan collection.
 * Prepared for future BullMQ priority queues.
 */
const calculatePriority = async (planKey = "free", status = "active") => {
  if (status !== "active" && status !== "trialing") {
    return DEFAULT_PRIORITY_MAP.free;
  }

  try {
    const plan = await Plan.findOne({ key: planKey.toLowerCase(), active: true });
    if (plan && plan.priorityScore !== undefined) {
      return plan.priorityScore;
    }
  } catch (error) {
    console.error("Error calculating priority score from DB:", error);
  }

  return DEFAULT_PRIORITY_MAP[planKey] || DEFAULT_PRIORITY_MAP.free;
};

module.exports = {
  DEFAULT_PRIORITY_MAP,
  calculatePriority,
};
