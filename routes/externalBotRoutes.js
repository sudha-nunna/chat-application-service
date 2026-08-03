const express = require("express");
const router = express.Router();
const botKeyAuth = require("../middleware/botKeyAuth");
const botController = require("../controllers/botController");

/**
 * Public External Bot Integration Endpoints
 * Authenticated via X-Bot-Api-Key and X-Bot-Secret-Key headers
 */

// POST /api/v1/external/bots/chat - Chat with Bot (SSE streaming or JSON)
router.post("/chat", botKeyAuth, botController.externalBotChat);
router.post("/chat/stream", botKeyAuth, botController.externalBotChat);

module.exports = router;
