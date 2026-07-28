const Plan = require("../models/Plan");

/**
 * GET /plans
 * Fetch all active plans sorted by displayOrder
 */
exports.getPlans = async (req, res) => {
  try {
    const plans = await Plan.find({ active: true }).sort({ displayOrder: 1 });
    res.json({
      success: true,
      plans,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /plans/:planKey
 * Fetch details of a single plan by key
 */
exports.getPlanByKey = async (req, res) => {
  try {
    const { planKey } = req.params;
    const plan = await Plan.findOne({ key: planKey.toLowerCase() });

    if (!plan) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    res.json({
      success: true,
      plan,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /plans
 * Admin: Create a new plan
 */
exports.createPlan = async (req, res) => {
  try {
    const planData = req.body;
    const existingPlan = await Plan.findOne({ key: planData.key.toLowerCase() });

    if (existingPlan) {
      return res.status(400).json({
        success: false,
        message: `Plan with key '${planData.key}' already exists`,
      });
    }

    const plan = await Plan.create(planData);
    res.status(201).json({
      success: true,
      message: "Plan created successfully",
      plan,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PUT /plans/:planKey
 * Admin: Update plan pricing, limits, features
 */
exports.updatePlan = async (req, res) => {
  try {
    const { planKey } = req.params;
    const updates = req.body;

    const plan = await Plan.findOneAndUpdate(
      { key: planKey.toLowerCase() },
      updates,
      { new: true, runValidators: true }
    );

    if (!plan) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    res.json({
      success: true,
      message: `Plan '${planKey}' updated successfully`,
      plan,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * DELETE /plans/:planKey
 * Admin: Deactivate a plan
 */
exports.deletePlan = async (req, res) => {
  try {
    const { planKey } = req.params;
    const plan = await Plan.findOneAndUpdate(
      { key: planKey.toLowerCase() },
      { active: false },
      { new: true }
    );

    if (!plan) {
      return res.status(404).json({ success: false, message: "Plan not found" });
    }

    res.json({
      success: true,
      message: `Plan '${planKey}' deactivated successfully`,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
