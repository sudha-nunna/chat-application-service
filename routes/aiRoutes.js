const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController"); // Points to streaming controller
const authMiddleware = require("../middleware/auth");
const Contact = require("../models/Contact");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

if (!protect) {
  console.error("CRITICAL ERROR: 'protect' middleware configuration missing!");
}

const { clusterState } = require("../utils/ollamaHelper");

// Calls the correct streaming method that handles "text/event-stream"
router.post("/message/:chatId", protect, chatController.sendMessage);

// Live Cluster Node Health & Load Diagnostics Route
router.get("/cluster-status", protect, async (req, res) => {
  try {
    const { clusterState, refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    await refreshClusterNodesFromDB();

    const sanitizedNodes = clusterState.map((node) => ({
      id: node.id,
      name: node.name,
      defaultModel: node.defaultModel,
      status: node.status,
      activeRequests: node.activeRequests || 0,
      lastLatencyMs: node.lastLatencyMs || node.latency || 0
    }));

    return res.json({
      success: true,
      totalNodes: sanitizedNodes.length,
      nodes: sanitizedNodes
    });
  } catch (err) {
    console.error("Error fetching cluster status:", err);
    return res.status(500).json({ error: "Failed to fetch cluster status." });
  }
});

// NEW CRM PROXY ROUTE: Captures AI payload and pushes safely to codegene.io using backend .env variables
router.post("/crm/forward-contact", protect, async (req, res) => {
  try {
    const payload = req.body;
    const apiKey = process.env.CRM_API_KEY ;
    const apiUrl = process.env.CRM_API_URL ;

    // ALSO STORE IN SEPARATE MONGOOSE CONTACT COLLECTION (Deduplicated by userId)
    if (payload.firstName && payload.lastName && payload.email && payload.phone) {
      try {
        await Contact.findOneAndUpdate(
          { userId: req.user.id },
          {
            userId: req.user.id,
            chatId: payload.chatId || req.user.id,
            firstName: payload.firstName,
            lastName: payload.lastName,
            email: payload.email,
            phone: payload.phone === "null" || !payload.phone ? null : payload.phone,
            companyName: payload.companyName === "null" || !payload.companyName ? null : payload.companyName
          },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.error("Contact collection saving notice:", dbErr.message);
      }
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone === "null" || !payload.phone ? null : payload.phone,
        companyName: payload.companyName === "null" || !payload.companyName ? null : payload.companyName,
        pipelineId: "64b1c2d3e4f5a6b7c8d9e0f1",
        stageId: "new",
        description: payload.description === "null" || !payload.description ? null : payload.description
      })
    });

    if (response.ok) {
      return res.status(200).json({ success: true, message: "Contact successfully synchronized on CRM grid." });
    } else {
      const errorText = await response.text();
      return res.status(response.status).json({ success: false, error: errorText });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal proxy routing error.", error: error.message });
  }
});

module.exports = router;




// const express = require("express");
// const router = express.Router();
// const chatController = require("../controllers/chatController"); //  Points to streaming controller
// const authMiddleware = require("../middleware/auth");

// const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

// if (!protect) {
//   console.error("CRITICAL ERROR: 'protect' middleware configuration missing!");
// }

// //  Calls the correct streaming method that handles "text/event-stream"
// router.post("/message/:chatId", protect, chatController.sendMessage);

// module.exports = router;