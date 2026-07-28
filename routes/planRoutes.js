const express = require("express");
const router = express.Router();
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
router.post("/", createPlan);
router.put("/:planKey", updatePlan);
router.delete("/:planKey", deletePlan);

module.exports = router;
