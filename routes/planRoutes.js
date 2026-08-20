const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const requireAdmin = authMiddleware.requireAdmin;
const {
  getPlans,
  getPlanByKey,
  createPlan,
  updatePlan,
  deletePlan,
} = require("../controllers/planController");

// Public endpoints
router.get("/", getPlans);
router.get("/:planKey", getPlanByKey);

// Admin endpoints for dynamic pricing/limit updates
router.post("/", protect, requireAdmin, createPlan);
router.put("/:planKey", protect, requireAdmin, updatePlan);
router.delete("/:planKey", protect, requireAdmin, deletePlan);

module.exports = router;
