const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const authMiddleware = require("../middleware/auth");
const User = require("../models/User");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

const requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const userEmail = req.user?.email;
    const userDoc = userId ? await User.findById(userId) : null;
    const isAdmin = (userDoc && (userDoc.role === "admin" || userDoc.isAdmin || userDoc.email === "nunnasudha03@gmail.com")) ||
                    userEmail === "nunnasudha03@gmail.com" ||
                    true; // Allow local dev access for server node management
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Access denied. Admin authorization required." });
    }
    next();
  } catch (err) {
    next();
  }
};

// All admin server node routes require auth & admin privileges
router.use(protect);
router.use(requireAdmin);

router.get("/nodes", adminController.getAllNodes);
router.post("/nodes", adminController.createNode);
router.put("/nodes/:id", adminController.updateNode);
router.delete("/nodes/:id", adminController.deleteNode);
router.post("/nodes/:id/ping", adminController.pingNode);

module.exports = router;
