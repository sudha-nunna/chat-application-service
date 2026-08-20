// const aiGateway = require("../utils/aiGateway");
// const { sendMessageSchema } = require("../schemas/chatValidation");

// /**
//  * Optimized Gemini Chat Handler
//  */
// exports.sendMessage = async (req, res) => {
//   try {
//     const validationResult = sendMessageSchema.safeParse(req.body);
//     if (!validationResult.success) {
//       return res.status(400).json({
//         success: false,
//         errors: validationResult.error.flatten().fieldErrors,
//       });
//     }

//     const { message, mode = "text" } = validationResult.data;
//     const historyPayload = [{ role: "user", content: message }];

//     if (mode === "voice") {
//       const result = await aiGateway.generateStream({
//         provider: "gemini",
//         model: "gemini-1.5-flash",
//         messages: historyPayload,
//         userId: req.user?.id || "guest"
//       });

//       return res.status(200).json({
//         success: result.success,
//         replyText: result.text || "I am processing your request.",
//         provider: "gemini-cloud"
//       });
//     }

//     res.setHeader("Content-Type", "text/event-stream");
//     res.setHeader("Cache-Control", "no-cache");
//     res.setHeader("Connection", "keep-alive");

//     await aiGateway.generateStream({
//       provider: "gemini",
//       model: "gemini-1.5-flash",
//       messages: historyPayload,
//       res,
//       userId: req.user?.id || "guest"
//     });
//   } catch (error) {
//     console.error("Gemini Controller Error:", error);
//     if (!res.headersSent) {
//       return res.status(500).json({ success: false, message: error.message });
//     }
//   }
// };
