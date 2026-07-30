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
 * Calculates quantitative priority score dynamically from the Plan collection or static map.
 */
const calculatePriority = async (planKey = "free", status = "active") => {
  const normalizedKey = (planKey || "free").toString().toLowerCase();

  if (status !== "active" && status !== "trialing") {
    return DEFAULT_PRIORITY_MAP.free;
  }

  // Quick synchronous map return for standard plans
  if (DEFAULT_PRIORITY_MAP[normalizedKey] !== undefined) {
    return DEFAULT_PRIORITY_MAP[normalizedKey];
  }

  try {
    const plan = await Plan.findOne({ key: normalizedKey, active: true }).maxTimeMS(1500);
    if (plan && plan.priorityScore !== undefined) {
      return plan.priorityScore;
    }
  } catch (error) {
    // Graceful fallback to static map
  }

  return DEFAULT_PRIORITY_MAP[normalizedKey] || DEFAULT_PRIORITY_MAP.free;
};

module.exports = {
  DEFAULT_PRIORITY_MAP,
  calculatePriority,
};
