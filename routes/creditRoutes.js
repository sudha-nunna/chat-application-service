const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const creditController = require("../controllers/creditController");

router.get("/packs", protect, creditController.getCreditPacks);
router.post("/purchase", protect, creditController.purchaseCredits);

module.exports = router;
