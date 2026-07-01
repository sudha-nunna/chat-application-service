// const fs = require("fs");
// const path = require("path");
// const Chat = require("../models/Chat");
// const Message = require("../models/Message");
// const Summary = require("../models/Summary"); // Handles context fetching/saving
// const { GoogleGenAI } = require("@google/genai");
// const { sendMessageSchema } = require("../schemas/chatValidation");

// const ai = new GoogleGenAI({
//   apiKey: process.env.GEMINI_API_KEY,
// });

// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// // =========================================================================
// // 💎 FREE-TIER LOCAL DOCUMENT PARSER (BYPASSES STORAGE CACHE LIMIT 0)
// // =========================================================================
// let creditCardKnowledgeBase = "";

// function loadLocalDocumentMatrix() {
//   try {
//     const pdfPath = path.join(__dirname, "../docs/chatpdf.txt"); 
//     if (fs.existsSync(pdfPath)) {
//       creditCardKnowledgeBase = fs.readFileSync(pdfPath, "utf-8");
//       console.log("🔒 Local document matrix text loaded successfully into memory.");
//     } else {
//       console.log("⚠️ /docs/chatpdf.txt file not found. Running workspace without grounding context data.");
//     }
//   } catch (error) {
//     console.error("Failed to read local document file:", error);
//   }
// }

// // Read the text file immediately when the Node server initializes
// loadLocalDocumentMatrix();
// // =========================================================================

// exports.sendMessage = async (req, res) => {
//   try {
//     const validationResult = sendMessageSchema.safeParse(req.body);
//     if (!validationResult.success) {
//       return res.status(400).json({
//         success: false,
//         errors: validationResult.error.flatten().fieldErrors,
//       });
//     }

//     // Capture explicit mode parameter securely (defaulting to text mode if not provided)
//     const { message, mode = "text" } = validationResult.data; 
//     let chatId = req.params.chatId;

//     let chat;
//     if (!chatId || chatId === "new" || chatId === "undefined") {
//       chat = await Chat.create({
//         userId: req.user.id,
//         title: message.substring(0, 30) || "New Chat",
//       });
//       chatId = chat._id;
//     } else {
//       chat = await Chat.findById(chatId);
//     }

//     if (!chat) {
//       return res
//         .status(404)
//         .json({ success: false, message: "Chat session not found" });
//     }

//     if (chat.title === "New Chat") {
//       chat.title = message.substring(0, 30);
//       await chat.save();
//     }

//     // 1. Save User message to Database
//     await Message.create({
//       chatId,
//       role: "user",
//       content: message,
//     });

//     // 2. Fetch the summarized context if it exists
//     const existingSummary = await Summary.findOne({ chatId });

//     // 3. Fetch only the last 4 messages to serve as recent context
//     const dbMessagesHistory = await Message.find({ chatId })
//       .sort({ createdAt: -1 })
//       .limit(4);

//     dbMessagesHistory.reverse();

//     // 4. Assemble payload for Gemini API
//     const historyPayload = [];

//     // Inject summary context if present
//     if (existingSummary && existingSummary.summarizedContent) {
//       historyPayload.push({
//         role: "user",
//         parts: [
//           {
//             text: `[System Context Summary of previous conversation]: ${existingSummary.summarizedContent}`,
//           },
//         ],
//       });
//       historyPayload.push({
//         role: "model",
//         parts: [
//           {
//             text: "Understood. I will retain this context for the conversation.",
//           },
//         ],
//       });
//     }

//     // Append recent messages
//     dbMessagesHistory.forEach((msg) => {
//       historyPayload.push({
//         role: msg.role === "assistant" ? "model" : "user",
//         parts: [{ text: msg.content }],
//       });
//     });

//     // Fallback variable structure if text content is missing
//     const finalMatrix = creditCardKnowledgeBase || "Default fallback: Answer based on standard credit card bank rules. Keep answers short.";

//     // Create dynamic instruction block containing our local memory file data
//     const runtimeSystemInstruction = `You are a voice assistant. Users are listening to your responses out loud. Follow these instructions strictly:
// 1. Be extremely concise. Keep your answers to a maximum of 2 to 3 simple, short sentences.
// 2. Never use any Markdown formatting like asterisks (**), hashtags (#), bullet points, or code blocks. Speak in plain, fluid, natural paragraphs.
// 3. If a response requires a long list or complex code explanation, give a 1-sentence summary and state: "I have displayed the details below for you to read."

// Official product guidelines documentation matrix to use as your absolute reference:
// ${finalMatrix}`;

//     const geminiConfig = {
//       model: "gemini-2.5-flash",
//       contents: historyPayload,
//       config: {
//         systemInstruction: runtimeSystemInstruction,
//       }
//     };

//     // =========================================================================
//     // 🔥 BRANCH A: FAST-REPLY SINGLE RESPONSE CHANNEL (VOICE MODE)
//     // =========================================================================
//     if (mode === "voice") {
//       let response;
//       try {
//         response = await ai.models.generateContent(geminiConfig);
//       } catch (apiError) {
//         if (apiError.status === 429) {
//           await delay(2000);
//           response = await ai.models.generateContent(geminiConfig);
//         } else {
//           throw apiError;
//         }
//       }

//       const replyText = response.text || "I am processing your product preferences details.";

//       await Message.create({
//         chatId,
//         role: "assistant",
//         content: replyText,
//       });

//       return res.status(200).json({
//         success: true,
//         replyText: replyText,
//         provider: "local-gemini-free-tier"
//       });
//     }

//     // =========================================================================
//     // 🔥 BRANCH B: CHUNK-BY-CHUNK STREAM CHANNEL (TEXT MODE FALLBACK)
//     // =========================================================================
//     res.setHeader("Content-Type", "text/event-stream");
//     res.setHeader("Cache-Control", "no-cache");
//     res.setHeader("Connection", "keep-alive");

//     res.write(
//       `data: ${JSON.stringify({ type: "meta", chatId, title: chat.title })}\n\n`,
//     );
//     await delay(500);

//     let responseStream;
//     try {
//       responseStream = await ai.models.generateContentStream(geminiConfig);
//     } catch (apiError) {
//       if (apiError.status === 429) {
//         await delay(2000);
//         responseStream = await ai.models.generateContentStream(geminiConfig);
//       } else {
//         throw apiError;
//       }
//     }

//     let accumulatedReplyText = "";
//     for await (const chunk of responseStream) {
//       const chunkText = chunk.text || "";
//       accumulatedReplyText += chunkText;
//       res.write(
//         `data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`,
//       );
//     }

//     const assistantMsg = await Message.create({
//       chatId,
//       role: "assistant",
//       content: accumulatedReplyText,
//     });

//     res.write("data: [DONE]\n\n");
//     res.end();

//     // BACKGROUND RUNTIME: Compress conversation history to summary
//     process.nextTick(async () => {
//       try {
//         const totalMessagesCount = await Message.countDocuments({ chatId });

//         if (totalMessagesCount > 4) {
//           const allMessages = await Message.find({ chatId }).sort({
//             createdAt: 1,
//           });

//           const summaryPrompt = `Summarize the following chat conversation history accurately, highlighting key facts, goals, and metrics discussed while keeping it brief:\n\n${allMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}`;

//           const summaryResult = await ai.models.generateContent({
//             model: "gemini-2.5-flash",
//             contents: summaryPrompt,
//           });

//           await Summary.findOneAndUpdate(
//             { chatId },
//             {
//               summarizedContent: summaryResult.text || "",
//               lastUpdatedMessageId: assistantMsg._id,
//             },
//             { upsert: true, new: true },
//           );
//         }
//       } catch (bgError) {
//         console.error("Background summary generation failed:", bgError);
//       }
//     });
//   } catch (error) {
//     console.error("CRITICAL STREAM RUNTIME ERROR:", error);

//     let uiMessage = "An unexpected server error occurred. Please try again.";
//     let errorType = "SERVER_ERROR";

//     if (error.status === 429 || error.message?.includes("429")) {
//       uiMessage = "Daily Gemini request quota exceeded. Please wait a minute or upgrade your plan.";
//       errorType = "QUOTA_EXCEEDED";
//     } else if (error.status === 503 || error.message?.includes("503")) {
//       uiMessage = "Gemini servers are currently experiencing high demand. Please try again in a few seconds.";
//       errorType = "SERVER_OVERLOAD";
//     }

//     if (!res.headersSent) {
//       res
//         .status(error.status || 500)
//         .json({ success: false, message: uiMessage, type: errorType });
//     } else {
//       res.write(
//         `data: ${JSON.stringify({ type: "error", message: uiMessage, errorType })}\n\n`,
//       );
//       res.end();
//     }
//   }
// };




// // const fs = require("fs");
// // const path = require("path");
// // const Chat = require("../models/Chat");
// // const Message = require("../models/Message");
// // const Summary = require("../models/Summary"); // Handles context fetching/saving
// // const { GoogleGenAI } = require("@google/genai");
// // const { sendMessageSchema } = require("../schemas/chatValidation");

// // const ai = new GoogleGenAI({
// //   apiKey: process.env.GEMINI_API_KEY,
// // });

// // const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// // // =========================================================================
// // // 💎 GOOGLE GEMINI LOCAL CONTEXT CACHE CORE
// // // =========================================================================
// // let sharedCacheName = null;

// // async function initializeDocumentCache() {
// //   try {
// //     const pdfPath = path.join(__dirname, "../docs/chatpdf.txt");
// //     if (!fs.existsSync(pdfPath)) {
// //       console.log("⚠️ /docs/chatpdf.txt document matrix file not found. Running workspace without cached grounding data.");
// //       return;
// //     }

// //     const fileContent = fs.readFileSync(pdfPath, "utf-8");

// //     // Upload and cache the document structure directly inside Google server RAM
// //     const cache = await ai.caches.create({
// //       model: "gemini-2.5-flash",
// //       config: {
// //         displayName: "credit_card_knowledge_base",
// //         ttl: "3600s", // Warmed cache lives for 1 hour. Hits automatically auto-renew its lifetime window.
// //         systemInstruction: `You are a voice assistant. Users are listening to your responses out loud. Follow these instructions strictly:
// // 1. Be extremely concise. Keep your answers to a maximum of 2 to 3 simple, short sentences.
// // 2. Never use any Markdown formatting like asterisks (**), hashtags (#), bullet points, or code blocks. Speak in plain, fluid, natural paragraphs.
// // 3. If a response requires a long list or complex code explanation, give a 1-sentence summary and state: "I have displayed the details below for you to read."`,
// //         contents: [
// //           {
// //             role: "user",
// //             parts: [{ text: `Official product guidelines documentation data matrix reference: \n\n${fileContent}` }],
// //           },
// //         ],
// //       },
// //     });

// //     sharedCacheName = cache.name;
// //     console.log("🔒 Google Cloud Context Cache warmed up successfully:", sharedCacheName);
// //   } catch (error) {
// //     console.error("CRITICAL: Failed to initialize localized context memory vectors:", error);
// //   }
// // }

// // // Instantiate cache handshake process on server runtime execution
// // initializeDocumentCache();
// // // =========================================================================

// // exports.sendMessage = async (req, res) => {
// //   try {
// //     const validationResult = sendMessageSchema.safeParse(req.body);
// //     if (!validationResult.success) {
// //       return res.status(400).json({
// //         success: false,
// //         errors: validationResult.error.flatten().fieldErrors,
// //       });
// //     }

// //     const { message, mode } = validationResult.data; // Expects mode from body pipeline
// //     let chatId = req.params.chatId;

// //     let chat;
// //     if (!chatId || chatId === "new" || chatId === "undefined") {
// //       chat = await Chat.create({
// //         userId: req.user.id,
// //         title: message.substring(0, 30) || "New Chat",
// //       });
// //       chatId = chat._id;
// //     } else {
// //       chat = await Chat.findById(chatId);
// //     }

// //     if (!chat) {
// //       return res
// //         .status(404)
// //         .json({ success: false, message: "Chat session not found" });
// //     }

// //     if (chat.title === "New Chat") {
// //       chat.title = message.substring(0, 30);
// //       await chat.save();
// //     }

// //     // 1. Save User message to Database
// //     await Message.create({
// //       chatId,
// //       role: "user",
// //       content: message,
// //     });

// //     // 2. Fetch the summarized context if it exists
// //     const existingSummary = await Summary.findOne({ chatId });

// //     // 3. Fetch only the last 4 messages to serve as recent context
// //     const dbMessagesHistory = await Message.find({ chatId })
// //       .sort({ createdAt: -1 })
// //       .limit(4);

// //     dbMessagesHistory.reverse();

// //     // 4. Assemble payload for Gemini API
// //     const historyPayload = [];

// //     // Inject summary context if present
// //     if (existingSummary && existingSummary.summarizedContent) {
// //       historyPayload.push({
// //         role: "user",
// //         parts: [
// //           {
// //             text: `[System Context Summary of previous conversation]: ${existingSummary.summarizedContent}`,
// //           },
// //         ],
// //       });
// //       historyPayload.push({
// //         role: "model",
// //         parts: [
// //           {
// //             text: "Understood. I will retain this context for the conversation.",
// //           },
// //         ],
// //       });
// //     }

// //     // Append recent messages
// //     dbMessagesHistory.forEach((msg) => {
// //       historyPayload.push({
// //         role: msg.role === "assistant" ? "model" : "user",
// //         parts: [{ text: msg.content }],
// //       });
// //     });

// //     // Assemble dynamic parameters config block mapping
// //     const geminiConfig = {
// //       model: "gemini-2.5-flash",
// //       contents: historyPayload,
// //       // If our high-speed cache is live on Google, use it. Otherwise fallback to inline string configurations
// //       config: sharedCacheName ? { cachedContent: sharedCacheName } : {
// //         systemInstruction: `You are a voice assistant. Users are listening to your responses out loud. Follow these instructions strictly:
// // 1. Be extremely concise. Keep your answers to a maximum of 2 to 3 simple, short sentences.
// // 2. Never use any Markdown formatting like asterisks (**), hashtags (#), bullet points, or code blocks. Speak in plain, fluid, natural paragraphs.
// // 3. If a response requires a long list or complex code explanation, give a 1-sentence summary and state: "I have displayed the details below for you to read."`,
// //       }
// //     };

// //     // =========================================================================
// //     // 🔥 BRANCH A: FAST-REPLY SINGLE RESPONSE CHANNEL (VOICE MODE)
// //     // =========================================================================
// //     if (mode === "voice") {
// //       let response;
// //       try {
// //         response = await ai.models.generateContent(geminiConfig);
// //       } catch (apiError) {
// //         if (apiError.status === 429) {
// //           await delay(2000);
// //           response = await ai.models.generateContent(geminiConfig);
// //         } else {
// //           throw apiError;
// //         }
// //       }

// //       const replyText = response.text || "I am processing your product preferences details.";

// //       // Save complete Assistant message block logs to Database storage collections
// //       await Message.create({
// //         chatId,
// //         role: "assistant",
// //         content: replyText,
// //       });

// //       return res.status(200).json({
// //         success: true,
// //         replyText: replyText,
// //         provider: "local-gemini-cache"
// //       });
// //     }

// //     // =========================================================================
// //     // 🔥 BRANCH B: CHUNK-BY-CHUNK STREAM CHANNEL (TEXT MODE FALLBACK)
// //     // =========================================================================
// //     res.setHeader("Content-Type", "text/event-stream");
// //     res.setHeader("Cache-Control", "no-cache");
// //     res.setHeader("Connection", "keep-alive");

// //     res.write(
// //       `data: ${JSON.stringify({ type: "meta", chatId, title: chat.title })}\n\n`,
// //     );
// //     await delay(500);

// //     let responseStream;
// //     try {
// //       responseStream = await ai.models.generateContentStream(geminiConfig);
// //     } catch (apiError) {
// //       if (apiError.status === 429) {
// //         await delay(2000);
// //         responseStream = await ai.models.generateContentStream(geminiConfig);
// //       } else {
// //         throw apiError;
// //       }
// //     }

// //     let accumulatedReplyText = "";
// //     for await (const chunk of responseStream) {
// //       const chunkText = chunk.text || "";
// //       accumulatedReplyText += chunkText;
// //       res.write(
// //         `data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`,
// //       );
// //     }

// //     // Save the complete Assistant message to Database
// //     const assistantMsg = await Message.create({
// //       chatId,
// //       role: "assistant",
// //       content: accumulatedReplyText,
// //     });

// //     res.write("data: [DONE]\n\n");
// //     res.end();

// //     // BACKGROUND RUNTIME: Compress conversation history to summary
// //     process.nextTick(async () => {
// //       try {
// //         const totalMessagesCount = await Message.countDocuments({ chatId });

// //         // If the chat log gets longer than 4 messages, recalculate the summary context
// //         if (totalMessagesCount > 4) {
// //           const allMessages = await Message.find({ chatId }).sort({
// //             createdAt: 1,
// //           });

// //           const summaryPrompt = `Summarize the following chat conversation history accurately, highlighting key facts, goals, and metrics discussed while keeping it brief:\n\n${allMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}`;

// //           const summaryResult = await ai.models.generateContent({
// //             model: "gemini-2.5-flash",
// //             contents: summaryPrompt,
// //           });

// //           await Summary.findOneAndUpdate(
// //             { chatId },
// //             {
// //               summarizedContent: summaryResult.text || "",
// //               lastUpdatedMessageId: assistantMsg._id,
// //             },
// //             { upsert: true, new: true },
// //           );
// //         }
// //       } catch (bgError) {
// //         console.error("Background summary generation failed:", bgError);
// //       }
// //     });
// //   } catch (error) {
// //     console.error("CRITICAL STREAM RUNTIME ERROR:", error);

// //     let uiMessage = "An unexpected server error occurred. Please try again.";
// //     let errorType = "SERVER_ERROR";

// //     if (error.status === 429 || error.message?.includes("429")) {
// //       uiMessage = "Daily Gemini request quota exceeded. Please wait a minute or upgrade your plan.";
// //       errorType = "QUOTA_EXCEEDED";
// //     } else if (error.status === 503 || error.message?.includes("503")) {
// //       uiMessage = "Gemini servers are currently experiencing high demand. Please try again in a few seconds.";
// //       errorType = "SERVER_OVERLOAD";
// //     }

// //     if (!res.headersSent) {
// //       res
// //         .status(error.status || 500)
// //         .json({ success: false, message: uiMessage, type: errorType });
// //     } else {
// //       res.write(
// //         `data: ${JSON.stringify({ type: "error", message: uiMessage, errorType })}\n\n`,
// //       );
// //       res.end();
// //     }
// //   }
// // };
