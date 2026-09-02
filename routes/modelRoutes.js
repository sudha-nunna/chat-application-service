const express = require("express");
const router = express.Router();
const modelController = require("../controllers/modelController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const requireAdmin = authMiddleware.requireAdmin;

// Public route for User Chat Interface (can be called with or without auth)
router.get("/available", modelController.getAvailableModels);

// Admin Routes
router.get("/admin/all", protect, requireAdmin, modelController.getAllModelsAdmin);
router.post("/admin", protect, requireAdmin, modelController.createModel);
router.put("/admin/:id", protect, requireAdmin, modelController.updateModel);
router.delete("/admin/:id", protect, requireAdmin, modelController.deleteModel);

module.exports = router;
