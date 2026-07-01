const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController"); // Points to streaming controller
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

if (!protect) {
  console.error("CRITICAL ERROR: 'protect' middleware configuration missing!");
}

// Calls the correct streaming method that handles "text/event-stream"
router.post("/message/:chatId", protect, chatController.sendMessage);

// NEW CRM PROXY ROUTE: Captures AI payload and pushes safely to codegene.io using backend .env variables
router.post("/crm/forward-contact", protect, async (req, res) => {
  try {
    const payload = req.body;
    const apiKey = process.env.CRM_API_KEY ;
    const apiUrl = process.env.CRM_API_URL ;

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
        phone: payload.phone || "+1234567890",
        companyName: payload.companyName || "Acme Corp",
        pipelineId: "64b1c2d3e4f5a6b7c8d9e0f1",
        stageId: "new",
        description: payload.description || "Created automatically by AI live agent assistant workspace interface."
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