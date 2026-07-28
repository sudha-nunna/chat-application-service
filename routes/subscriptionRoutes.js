const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const {
  getSubscription,
  upgradePlan,
  downgradePlan,
  cancelSubscription,
  getUsage,
  handleWebhook,
} = require("../controllers/subscriptionController");

// Public webhook route
router.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

// Protected subscription routes
router.get("/me", auth, getSubscription);
router.get("/usage", auth, getUsage);
router.post("/upgrade", auth, upgradePlan);
router.post("/downgrade", auth, downgradePlan);
router.post("/cancel", auth, cancelSubscription);

module.exports = router;
