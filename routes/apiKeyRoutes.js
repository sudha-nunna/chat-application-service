const express = require("express");
const router = express.Router();
const apiKeyController = require("../controllers/apiKeyController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

if (!protect) {
  console.error("CRITICAL ERROR: 'protect' middleware configuration missing for apiKeyRoutes!");
}

// Routes for user dashboard API Key management
router.post("/", protect, apiKeyController.createApiKey);
router.get("/", protect, apiKeyController.getApiKeys);
router.delete("/:keyId", protect, apiKeyController.revokeApiKey);
router.get("/:keyId/stats", protect, apiKeyController.getApiKeyStats);

module.exports = router;
