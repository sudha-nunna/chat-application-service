const User = require("../models/User");
const { calculatePriority } = require("../utils/priorityCalculator");

/**
 * Middleware: Enforces minimum subscription plan level for specific routes.
 * Example usage: router.post("/pro-feature", auth, requirePlan(["pro", "enterprise"]), controller);
 */
const requirePlan = (allowedPlans = ["pro", "enterprise"]) => {
  return async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id).select("plan");
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      if (!allowedPlans.includes(user.plan)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Requires one of the following plans: ${allowedPlans.join(", ")}`,
          currentPlan: user.plan,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  };
};

/**
 * Middleware: Attaches priority score to request context (req.userPriority)
 * for future Redis / BullMQ priority queue dispatchers.
 */
const attachRequestPriority = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("plan");
    const plan = user ? user.plan : "free";
    
    req.userPriority = calculatePriority(plan);
    next();
  } catch (error) {
    req.userPriority = calculatePriority("free");
    next();
  }
};

module.exports = {
  requirePlan,
  attachRequestPriority,
};
