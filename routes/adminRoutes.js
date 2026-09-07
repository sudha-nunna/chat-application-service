const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const authMiddleware = require("../middleware/auth");
const { serverNodeAccessControl } = require("../middleware/serverNodeAccess");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const requireAdmin = authMiddleware.requireAdmin;

// Public Admin Auth Routes
router.post("/login/google", adminController.googleAdminLogin);

// Protected Admin Routes
router.use(protect);

// Dashboard Stats
router.get("/stats", requireAdmin, adminController.getDashboardStats);

// Node Management (Protected servernodes collection: Human Admin Full CRUD, AI Agent Read-only, Normal User 403)
router.get("/nodes", serverNodeAccessControl, adminController.getAllNodes);
router.post("/nodes", serverNodeAccessControl, adminController.createNode);
router.post("/nodes/sync-cluster", serverNodeAccessControl, adminController.syncClusterHealth);
router.post("/nodes/discover-models", serverNodeAccessControl, adminController.discoverServerModels);
router.put("/nodes/:id", serverNodeAccessControl, adminController.updateNode);
router.delete("/nodes/:id", serverNodeAccessControl, adminController.deleteNode);
router.post("/nodes/:id/ping", serverNodeAccessControl, adminController.pingNode);

// User & Credit Management
router.get("/users", requireAdmin, adminController.getAllUsers);
router.put("/users/:id/credits", requireAdmin, adminController.updateUserCredits);
router.put("/users/:id/role", requireAdmin, adminController.updateUserRole);
router.post("/users/grant-admin", requireAdmin, adminController.grantAdminAccess);

// Subscription Plans
router.get("/plans", requireAdmin, adminController.getAllPlans);
router.post("/plans", requireAdmin, adminController.createPlan);
router.put("/plans/:id", requireAdmin, adminController.updatePlan);
router.delete("/plans/:id", requireAdmin, adminController.deletePlan);

// Global System Settings & Dynamic Welcome Credits
router.get("/settings", requireAdmin, adminController.getSettings);
router.put("/settings", requireAdmin, adminController.updateSettings);

// Promotional Campaign Offers
router.get("/promos", requireAdmin, adminController.getPromos);
router.post("/promos", requireAdmin, adminController.createPromo);
router.put("/promos/:id", requireAdmin, adminController.updatePromo);
router.delete("/promos/:id", requireAdmin, adminController.deletePromo);

module.exports = router;
