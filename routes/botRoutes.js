const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const { checkAgentLimit } = require("../middleware/limitMiddleware");
const botController = require("../controllers/botController");
const avatarController = require("../controllers/avatarController");

// General Public & Avatar Chat Endpoints (Declared before :botId param routes)
router.post("/avatar/chat", avatarController.handleAvatarChat);

// Bot CRUD & Key Lifecycle Management
router.post("/", protect, checkAgentLimit, botController.createBot);
router.get("/", protect, botController.getBots);
router.get("/:botId", protect, botController.getBotById);
router.put("/:botId", protect, botController.updateBot);
router.patch("/:botId", protect, botController.updateBot);
router.delete("/:botId", protect, botController.deleteBot);

// Bot API Key & Secret Key Management (Production Standard)
router.get("/:botId/keys", protect, botController.getBotKeys);                // GET Bot Keys
router.post("/:botId/keys/generate", protect, botController.generateBotKeys);  // POST Generate & Regenerate Keys

// Knowledge Upload, Avatars & Media Assets
router.get("/media/:assetId", botController.streamMediaAsset);
router.post("/:botId/upload", protect, botController.uploadBotFile);
router.post("/:botId/avatar", protect, botController.uploadBotAvatar);
router.get("/:botId/files", protect, botController.getBotFiles);
router.put("/:botId/files/:fileId", protect, botController.replaceBotFile);
router.delete("/:botId/files/:fileId", protect, botController.deleteBotFile);

// Granular Rules Management
router.put("/:botId/rules", protect, botController.updateBotRules);

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
