const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const { checkAgentLimit } = require("../middleware/limitMiddleware");
const botController = require("../controllers/botController");
const avatarController = require("../controllers/avatarController");

const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    let token = authHeader.trim();
    if (token.startsWith("Bearer ") || token.includes(" ")) {
      token = token.split(" ")[1];
    }
    if (token) {
      try {
        const jwt = require("jsonwebtoken");
        req.user = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {}
    }
  }
  next();
};

const handleMulterFields = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.warn("Multer upload notice:", err.message);
    }
    next();
  });
};

// Avatar Chat Endpoint (Supports optional JWT Bearer token; accepts both audio and audioFile field names)
router.post(
  "/avatar/chat",
  optionalAuth,
  handleMulterFields,
  avatarController.handleAvatarChat
);

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
router.post("/:botId/upload", protect, handleMulterFields, botController.uploadBotFile);
router.post("/:botId/avatar", protect, handleMulterFields, botController.uploadBotAvatar);
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
