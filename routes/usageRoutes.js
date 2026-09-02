const express = require("express");
const router = express.Router();
const usageController = require("../controllers/usageController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

router.get("/summary", protect, usageController.getUserUsageSummary);

module.exports = router;
