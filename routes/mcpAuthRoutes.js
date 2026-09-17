const express = require("express");
const router = express.Router();
const mcpAuthController = require("../controllers/mcpAuthController");
const authMiddleware = require("../middleware/auth");


// Public OAuth endpoints (state token validated internally)
router.get("/oauth/connect/slack", authMiddleware, mcpAuthController.connectSlack);
router.get("/oauth/callback", mcpAuthController.slackCallback);

// User connection status and disconnect REST APIs
router.get("/user/status/slack", authMiddleware, mcpAuthController.getUserStatus);
router.post("/user/disconnect/slack", authMiddleware, mcpAuthController.disconnectUser);

module.exports = router;
