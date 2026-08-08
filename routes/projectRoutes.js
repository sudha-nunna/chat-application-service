const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;
const projectController = require("../controllers/projectController");

router.post("/", protect, projectController.createProject);
router.get("/", protect, projectController.getProjects);
router.get("/:projectId", protect, projectController.getProjectById);
router.put("/:projectId", protect, projectController.updateProject);

module.exports = router;
