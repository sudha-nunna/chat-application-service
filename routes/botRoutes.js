const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const { checkAgentLimit } = require("../middleware/limitMiddleware");
const botController = require("../controllers/botController");
const avatarController = require("../controllers/avatarController");

const multer = require("multer");

/**
 * MIME type allowlist for bot file uploads.
 * Only explicitly whitelisted types are accepted.
 * Prevents upload of executables, scripts, or other dangerous file types.
 */
const ALLOWED_MIME_TYPES = new Set([
  // Images (avatar)
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Audio (voice samples, TTS references)
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
  // Documents (knowledge base)
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/octet-stream" // Fallback for some browser/OS combinations
]);

function mimeTypeFilter(req, file, cb) {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
    err.message = `File type "${file.mimetype}" is not allowed. Accepted types: images, audio, PDF, and plain text.`;
    cb(err, false);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: mimeTypeFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file (covers high-quality voice samples & avatars)
    files: 2,                   // Max 2 files per request
    fields: 20
  }
});

const uploadFieldsHandler = upload.fields([
  { name: "avatar", maxCount: 1 },
  { name: "document", maxCount: 1 },
  { name: "audio", maxCount: 1 },
  { name: "audioFile", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "voice", maxCount: 1 },
  { name: "image", maxCount: 1 }
]);

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
  uploadFieldsHandler(req, res, (err) => {
    if (err) {
      console.warn("Multer upload notice:", err.message);
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    next();
  });
};

// Avatar Chat Endpoint & History Management (Protected by JWT Bearer token for strict user security)
router.post(
  ["/avatar/chat", "/chat"],
  optionalAuth,
  handleMulterFields,
  avatarController.handleAvatarChat
);
router.get(["/avatar/conversations", "/conversations"], protect, avatarController.getAvatarConversations);
router.post(["/avatar/conversations", "/conversations"], protect, avatarController.createAvatarConversation);
router.get(["/avatar/conversations/:conversationId/messages", "/conversations/:conversationId/messages"], protect, avatarController.getAvatarMessages);
router.delete(["/avatar/conversations/:conversationId", "/conversations/:conversationId"], protect, avatarController.deleteAvatarConversation);

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
const authCtrl = require("../controllers/authController");
router.get("/voice-sample", protect, authCtrl.getUserVoiceSamples);
router.get("/voice-samples", protect, authCtrl.getUserVoiceSamples);
router.put("/voice-sample/:sampleId/select", protect, authCtrl.selectUserVoiceSample);
router.put("/voice-samples/:sampleId/select", protect, authCtrl.selectUserVoiceSample);
router.put("/voice-sample/:sampleId", protect, handleMulterFields, authCtrl.updateUserVoiceSample);
router.put("/voice-samples/:sampleId", protect, handleMulterFields, authCtrl.updateUserVoiceSample);
router.delete("/voice-sample/:sampleId", protect, authCtrl.deleteUserVoiceSample);
router.delete("/voice-samples/:sampleId", protect, authCtrl.deleteUserVoiceSample);

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
