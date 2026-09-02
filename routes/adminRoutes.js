const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const requireAdmin = authMiddleware.requireAdmin;

// Public Admin Auth Routes
router.post("/login/google", adminController.googleAdminLogin);

// Protected Admin Routes
router.use(protect);
router.use(requireAdmin);

// Dashboard Stats
router.get("/stats", adminController.getDashboardStats);

// Node Management
router.get("/nodes", adminController.getAllNodes);
router.post("/nodes", adminController.createNode);
router.post("/nodes/discover-models", adminController.discoverServerModels);
router.put("/nodes/:id", adminController.updateNode);
router.delete("/nodes/:id", adminController.deleteNode);
router.post("/nodes/:id/ping", adminController.pingNode);

// User & Credit Management
router.get("/users", adminController.getAllUsers);
router.put("/users/:id/credits", adminController.updateUserCredits);

// Subscription Plans
router.get("/plans", adminController.getAllPlans);
router.post("/plans", adminController.createPlan);
router.put("/plans/:id", adminController.updatePlan);
router.delete("/plans/:id", adminController.deletePlan);

module.exports = router;
