const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const { checkAgentLimit } = require("../middleware/limitMiddleware");
const botController = require("../controllers/botController");

// Bot CRUD
router.post("/", protect, checkAgentLimit, botController.createBot);
router.get("/", protect, botController.getBots);
router.get("/:botId", protect, botController.getBotById);
router.put("/:botId", protect, botController.updateBot);
router.delete("/:botId", protect, botController.deleteBot);

// Knowledge Upload & Files
router.post("/:botId/upload", protect, botController.uploadBotFile);
router.get("/:botId/files", protect, botController.getBotFiles);
router.put("/:botId/files/:fileId", protect, botController.replaceBotFile);
router.delete("/:botId/files/:fileId", protect, botController.deleteBotFile);

// API Integrations
router.post("/:botId/apis", protect, botController.createBotApi);
router.get("/:botId/apis", protect, botController.getBotApis);
router.delete("/:botId/apis/:apiId", protect, botController.deleteBotApi);
router.post("/:botId/apis/:apiId/test", protect, botController.testBotApi);

// RAG Bot Chat & Conversations
router.post("/:botId/chat", protect, botController.sendBotChatMessage);
router.get("/:botId/conversations", protect, botController.getBotConversations);
router.post("/:botId/conversations", protect, botController.createBotConversation);
router.delete("/:botId/conversations/:conversationId", protect, botController.deleteBotConversation);
router.get("/:botId/conversations/:conversationId/messages", protect, botController.getBotMessages);

module.exports = router;
