const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const optionalAuth = authMiddleware.optionalAuth;

// ─── Public share viewer (no login required) ───────────────────────────────
// Declared BEFORE router.use(protect) so anonymous users can view shared links.
// optionalAuth still populates req.user when a valid JWT is sent, enabling isOwner checks.
router.get("/share/:chatId", optionalAuth, chatController.getSharedChat);

// ─── All other chat routes require authentication ──────────────────────────
router.use(protect);

router.post("/", chatController.createChat);
router.get("/", chatController.getChats);
router.get("/:chatId/messages", chatController.getMessages);
router.post("/:chatId/messages/stop", chatController.stopMessage);
router.post("/:chatId/share", chatController.shareChat);
router.post("/share/:chatId/fork", chatController.forkSharedChat);
router.put("/:chatId", chatController.updateChat);
router.patch("/:chatId", chatController.updateChat);
router.delete("/:chatId", chatController.deleteChat);

module.exports = router;