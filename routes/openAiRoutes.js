const express = require("express");
const router = express.Router();
const openAiApiController = require("../controllers/openAiApiController");
const { authenticateApiKey } = require("../middleware/apiKeyAuth");

// Public OpenAI-Compatible Endpoints
router.post("/chat/completions", authenticateApiKey, openAiApiController.chatCompletions);
router.get("/models", authenticateApiKey, openAiApiController.listModels);

module.exports = router;
