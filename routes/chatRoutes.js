const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

router.use(protect);

router.post("/", chatController.createChat);
router.get("/", chatController.getChats);
router.get("/:chatId/messages", chatController.getMessages);
router.post("/:chatId/share", chatController.shareChat);
router.get("/share/:chatId", chatController.getSharedChat);
router.post("/share/:chatId/fork", chatController.forkSharedChat);
router.put("/:chatId", chatController.updateChat);
router.patch("/:chatId", chatController.updateChat);
router.delete("/:chatId", chatController.deleteChat);

module.exports = router;