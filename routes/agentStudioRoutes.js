const express = require("express");
const router = express.Router();
const agentStudioController = require("../controllers/agentStudioController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

// Health check
router.get("/health", (req, res) => {
  res.json({ success: true, service: "Agent Studio Service", timestamp: new Date().toISOString() });
});

// Agent Management Routes
router.get("/", protect, agentStudioController.listAgents);
router.post("/", protect, agentStudioController.createAgent);
router.get("/:id", protect, agentStudioController.getAgentById);
router.put("/:id", protect, agentStudioController.updateAgent);
router.delete("/:id", protect, agentStudioController.deleteAgent);

// Knowledge Base Ingestion Routes
router.post("/:id/knowledge/upload", protect, agentStudioController.uploadAgentKnowledge);
router.post("/:id/knowledge/url", protect, agentStudioController.linkAgentKnowledgeUrl);
router.delete("/:id/knowledge/:sourceId", protect, agentStudioController.deleteAgentKnowledge);

// Conversational Turn Execution Engine (for Test Panel & Live Chat)
router.post("/:id/chat", agentStudioController.executeFlowTurn);

// Custom Voice Upload & Recording for F5-TTS
const multer = require("multer");
const voiceUpload = multer({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
router.post("/voice/upload", voiceUpload.single("audio"), agentStudioController.uploadCustomVoiceSample);
router.post("/voice/preview", agentStudioController.previewVoiceSpeech);

module.exports = router;
