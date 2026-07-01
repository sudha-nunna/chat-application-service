const fs = require("fs");
const path = require("path");
const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Summary = require("../models/Summary");

const MODEL_NAME = "qwen2.5:1.5b";

// Sanitizes the incoming environment string and cleanly strips any trailing slashes to prevent Cloudflare route breaks
const OLLAMA_BASE_URL = process.env.OLLAMA_HOST_URL 
  ? process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "") 
  : "http://127.0.0.1:11434";

// 1. CHAT DATABASE MANAGEMENT (CRUD)

exports.createChat = async (req, res) => {
  try {
    const chat = await Chat.create({
      userId: req.user.id,
      title: "New Chat",
    });
    res.status(201).json(chat);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getChats = async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user.id }).sort({ updatedAt: -1 });
    res.json(chats);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    await Chat.findByIdAndDelete(chatId);
    await Message.deleteMany({ chatId });
    await Summary.deleteOne({ chatId }); // Cascade deletion clears summary memory leakage

    res.json({ success: true, message: "Chat and related components successfully cleared." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// 2. AI STREAMING CORE ENGINE

exports.sendMessage = async (req, res) => {
  try {
    const { message } = req.body;
    let chatId = req.params.chatId;

    if (!message) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    let chat;
    if (!chatId || chatId === "new" || chatId === "undefined" || chatId === "null") {
      chat = await Chat.create({
        userId: req.user.id,
        title: message.substring(0, 30) || "New Automation Task",
      });
      chatId = chat._id;
    } else {
      chat = await Chat.findById(chatId);
    }

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat session tracking not found." });
    }

    await Message.create({ chatId, role: "user", content: message });

    const existingSummary = await Summary.findOne({ chatId });
    const dbMessagesHistory = await Message.find({ chatId }).sort({ createdAt: -1 }).limit(4);
    dbMessagesHistory.reverse();

    const historyPayload = [];

    const docPath = path.join(__dirname, "../docs/chatpdf.txt");
    let groundingMatrix = "No secondary structural reference document found.";
    if (fs.existsSync(docPath)) {
      groundingMatrix = fs.readFileSync(docPath, "utf-8");
    }

const systemInstruction = `You are an AI Assistant for the Allvion CRM platform. Your objective is to help the visitor register their context details in our management workflow.

RULES:
1. You must interact warmly and collect their First Name, Last Name, Email, Phone, and Company Name.
2. If the user asks for enterprise walkthroughs or pricing, say: "I will gladly capture your primary context details right here to instantly connect you directly with our specialized engineering team for a full custom walkthrough."
3. Once all data parameters are collected and they confirm submission, you MUST output this exact plain text block on a brand-new line at the very end of your response. Substitute the values precisely:

TRIGGER_START
firstName: USER_FIRST_NAME
lastName: USER_LAST_NAME
email: USER_EMAIL
phone: USER_PHONE
companyName: USER_COMPANY_NAME
description: USER_REQUIREMENTS_SUMMARY
TRIGGER_END

Do not wrap the block above in markdown code blocks or brackets. Output it as plain text.

REFERENCE SPECS WORKSPACE GROUNDING MATRIX:
${groundingMatrix}`;

    historyPayload.push({ role: "system", content: systemInstruction });

    if (existingSummary && existingSummary.summarizedContent) {
      historyPayload.push({ role: "user", content: `Summary of previous conversation context: ${existingSummary.summarizedContent}` });
      historyPayload.push({ role: "assistant", content: "Acknowledged. I have indexed the historical execution boundaries." });
    }

    dbMessagesHistory.forEach((msg) => {
      historyPayload.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(`data: ${JSON.stringify({ type: "meta", chatId, title: chat.title })}\n\n`);

    // Main Stream Request with updated global headers routing cleanly to Cloudflare endpoints
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // CRITICAL: Bypasses Cloudflare's 403 anti-bot validation screen completely
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: historyPayload,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama Gateway returned status ${response.status}: ${await response.text()}`);
    }

    let accumulatedResponseText = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkStr = decoder.decode(value, { stream: true });
      const lines = chunkStr.split("\n").filter(line => line.trim() !== "");

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const chunkText = parsed.message?.content || "";
          accumulatedResponseText += chunkText;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
        } catch (e) {
          // Ignore partial line splits
        }
      }
    }

    const assistantMsg = await Message.create({
      chatId,
      role: "assistant",
      content: accumulatedResponseText,
    });

    res.write("data: [DONE]\n\n");
    res.end();

    // Background compilation for thread summarization task metrics
    process.nextTick(async () => {
      try {
        const totalMessagesCount = await Message.countDocuments({ chatId });
        if (totalMessagesCount > 4) {
          const allMessages = await Message.find({ chatId }).sort({ createdAt: 1 });
          const summaryPrompt = `Analyze and summarize this engineering task run history into an indexable structural context payload block. Highlight file configurations altered and code components created:\n\n${allMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}`;

          const summaryResponse = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // CRITICAL: Added security headers here to avoid background 403 route execution blocks
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              "X-Requested-With": "XMLHttpRequest"
            },
            body: JSON.stringify({
              model: MODEL_NAME,
              messages: [{ role: "user", content: summaryPrompt }],
              stream: false
            })
          });

          if (summaryResponse.ok) {
            const summaryData = await summaryResponse.json();
            await Summary.findOneAndUpdate(
              { chatId },
              {
                summarizedContent: summaryData.message?.content || "",
                lastUpdatedMessageId: assistantMsg._id,
              },
              { upsert: true, new: true }
            );
          }
        }
      } catch (bgError) {
        console.error("Local background context summary loop skipped:", bgError);
      }
    });

  } catch (error) {
    console.error("Ollama Pipeline Error Handling Vector Layer Failure:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Local AI streaming runtime failure.", error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Stream connection broken by local computational runtime failure." })}\n\n`);
      res.end();
    }
  }
};



// const Chat = require("../models/Chat");
// const Message = require("../models/Message");
// const Summary = require("../models/Summary");

// exports.createChat = async (req, res) => {
//   try {
//     const chat = await Chat.create({
//       userId: req.user.id,
//       title: "New Chat",
//     });
//     res.status(201).json(chat);
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

// exports.getChats = async (req, res) => {
//   try {
//     const chats = await Chat.find({ userId: req.user.id }).sort({ updatedAt: -1 });
//     res.json(chats);
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

// exports.getMessages = async (req, res) => {
//   try {
//     const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
//     res.json(messages);
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// };

// exports.deleteChat = async (req, res) => {
//   try {
//     const { chatId } = req.params;
//     await Chat.findByIdAndDelete(chatId);
//     await Message.deleteMany({ chatId });
//     await Summary.deleteOne({ chatId }); // Cascade deletion clears summary memory leakage

//     res.json({ success: true, message: "Chat and related components successfully cleared." });
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// };