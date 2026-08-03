const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const { checkAgentLimit } = require("../middleware/limitMiddleware");
const botController = require("../controllers/botController");

// Bot CRUD & Key Lifecycle Management
router.post("/", protect, checkAgentLimit, botController.createBot);
router.get("/", protect, botController.getBots);
router.get("/:botId", protect, botController.getBotById);
router.put("/:botId", protect, botController.updateBot);
router.delete("/:botId", protect, botController.deleteBot);

// Bot API Key & Secret Key Routes
router.post("/:botId/keys/generate", protect, botController.generateBotKeys);
router.post("/:botId/keys", protect, botController.generateBotKeys);
router.get("/:botId/keys", protect, botController.getBotKeys);
router.get("/:botId/keys/generate", protect, botController.getBotKeys);
router.delete("/:botId/keys", protect, botController.revokeBotKeys);
router.post("/:botId/keys/rotate", protect, botController.rotateBotKeys);

// Knowledge Upload & Files
router.post("/:botId/upload", protect, botController.uploadBotFile);
router.get("/:botId/files", protect, botController.getBotFiles);
router.put("/:botId/files/:fileId", protect, botController.replaceBotFile);
router.delete("/:botId/files/:fileId", protect, botController.deleteBotFile);

// API Integrations & Postman Collections
router.post("/:botId/apis", protect, botController.createBotApi);
router.get("/:botId/apis", protect, botController.getBotApis);
router.put("/:botId/apis/:apiId", protect, botController.updateBotApi);
router.delete("/:botId/apis/:apiId", protect, botController.deleteBotApi);
router.post("/:botId/apis/:apiId/test", protect, botController.testBotApi);
router.post("/:botId/postman-import", protect, botController.importPostmanCollection);
router.get("/:botId/postman-apis", protect, botController.getPostmanApis);
router.put("/:botId/postman-apis/:apiId", protect, botController.updatePostmanApi);
router.delete("/:botId/postman-apis/:apiId", protect, botController.deletePostmanApi);

// RAG Bot Chat & Conversations
router.post("/:botId/chat", protect, botController.sendBotChatMessage);
router.post("/:botId/chat/stream", protect, botController.sendBotChatMessage);
router.get("/:botId/conversations", protect, botController.getBotConversations);
router.post("/:botId/conversations", protect, botController.createBotConversation);
router.delete("/:botId/conversations/:conversationId", protect, botController.deleteBotConversation);
router.get("/:botId/conversations/:conversationId/messages", protect, botController.getBotMessages);

module.exports = router;
