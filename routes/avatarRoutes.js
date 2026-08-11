const express = require("express");
const router = express.Router();
const avatarController = require("../controllers/avatarController");

// Public Avatar Chat Endpoints (No JWT token required)
router.post("/chat", avatarController.handleAvatarChat);
router.post("/:botId/chat", avatarController.handleAvatarChat);

module.exports = router;
