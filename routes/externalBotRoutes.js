const express = require("express");
const router = express.Router();
const botKeyAuth = require("../middleware/botKeyAuth");
const botController = require("../controllers/botController");
const avatarController = require("../controllers/avatarController");

/**
 * Public External Bot Integration Endpoints
 * Authenticated via X-Bot-Api-Key and X-Bot-Secret-Key headers
 */

// POST /api/v1/external/bots/chat - Chat with Bot (SSE streaming)
router.post("/chat", botKeyAuth, botController.externalBotChat);

module.exports = router;
