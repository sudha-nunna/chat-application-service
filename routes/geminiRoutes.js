const express = require("express");
const router = express.Router();
const geminiController = require("../controllers/geminiController");

// Destructured call function layout fix
// Mee middleware dynamic assignment wrapper syntax default file configuration setup base properties pattern map check chestundi
const authMiddleware = require("../middleware/auth"); 

// Middleware dynamic object attributes variations safely handle context assignment pipeline wrapper block check
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

if (!protect) {
  console.error("CRITICAL ERROR: 'protect' middleware dynamic parameter match check error layer missing!");
}

// Fixed endpoint initialization configuration routing instance call logic trace structure
router.post("/message/:chatId", protect, geminiController.sendMessage);

module.exports = router;