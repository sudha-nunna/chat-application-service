const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Summary = require("../models/Summary");
const { generateLLMSummary } = require("../utils/ragEngine");
const { getOllamaBaseUrl, getAvailableOllamaModel } = require("../utils/ollamaHelper");

/**
 * Streams text chunk-by-chunk over SSE to simulate word-by-word typing like ChatGPT.
 */
async function streamTextInChunks(res, text, delayMs = 15) {
  const tokens = text.match(/\s+|\S+/g) || [text];
  for (const token of tokens) {
    res.write(`data: ${JSON.stringify({ type: "chunk", text: token })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Helper to update rolling summary using LLM narrative generation when message count exceeds 20.
 */
async function updateRollingSummaryIfNeeded(chat, chatId) {
  try {
    const totalMessages = await Message.countDocuments({ chatId });
    if (totalMessages >= 20 && totalMessages % 5 === 0) {
      const recentMessages = await Message.find({ chatId }).sort({ createdAt: -1 }).limit(10);
      recentMessages.reverse();

      const rollingSummary = await generateLLMSummary(recentMessages, chat.conversationSummary);

      chat.conversationSummary = rollingSummary;
      await chat.save();

      await Summary.findOneAndUpdate(
        { chatId },
        {
          summarizedContent: rollingSummary,
          lastUpdatedMessageId: recentMessages[recentMessages.length - 1]._id
        },
        { upsert: true }
      );

      return rollingSummary;
    }
  } catch (err) {
    console.error("Failed to generate rolling summary:", err.message);
  }
  return chat.conversationSummary || "";
}

// -----------------------------------------------------------------------------
// 1. GENERAL CHAT DATABASE MANAGEMENT (CRUD)
// -----------------------------------------------------------------------------

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
    await Summary.deleteOne({ chatId });

    res.json({ success: true, message: "Chat cleared successfully." });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// -----------------------------------------------------------------------------
// 2. UNRESTRICTED GENERAL CHAT ENGINE WITH FULL CONVERSATION MEMORY
// -----------------------------------------------------------------------------

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
        title: message.substring(0, 30) || "General Chat",
      });
      chatId = chat._id;
    } else {
      chat = await Chat.findById(chatId);
    }

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat session not found." });
    }

    // Save User message
    await Message.create({ chatId, role: "user", content: message });

    // Update rolling summary if total messages >= 20
    const summaryText = await updateRollingSummaryIfNeeded(chat, chatId);

    // Fetch last 10 messages for conversation memory context
    const dbMessagesHistory = await Message.find({ chatId }).sort({ createdAt: -1 }).limit(10);
    dbMessagesHistory.reverse();

    // Comprehensive System Prompt matching ChatGPT/Gemini behavior
    const SYSTEM_PROMPT = `You are a helpful, intelligent, conversational AI assistant.

Requirements:
- Answer naturally, warmly, and engagingly like ChatGPT and Gemini.
- Understand greetings (e.g. "hello", "hi", "good morning") and reply conversationally.
- Understand follow-up questions and maintain context across multi-turn conversations (e.g. remembering prior topics, symptoms, or code).
- Generate jokes, creative content, stories, and riddles when asked.
- Explain concepts clearly using structured Markdown formatting and concise code blocks.
- Help with coding, health, science, education, productivity, news, and research.
- Never repeat canned responses or boilerplate fallbacks unless explicitly required.`;

    // Build context window payload
    const historyPayload = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      }
    ];

    if (summaryText && summaryText.trim()) {
      historyPayload.push({
        role: "system",
        content: `Conversation Summary:\n${summaryText}`
      });
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

    const OLLAMA_BASE_URL = getOllamaBaseUrl();
    const resolvedModel = await getAvailableOllamaModel(OLLAMA_BASE_URL, process.env.OLLAMA_MODEL);

    // Detailed Logging: Request Payload
    console.log(`\n=================== [GENERAL CHAT REQUEST] ===================`);
    console.log(`Target URL: ${OLLAMA_BASE_URL}/api/chat`);
    console.log(`Configured Model: ${process.env.OLLAMA_MODEL || "none"}`);
    console.log(`Resolved Ollama Model: ${resolvedModel}`);
    console.log(`Chat ID: ${chatId}`);
    console.log(`Total Messages In Payload: ${historyPayload.length}`);
    console.log(`Current User Prompt: "${message}"`);
    console.log(`===============================================================\n`);

    let accumulatedResponseText = "";
    let streamedSuccessfully = false;

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/event-stream",
          "Accept-Encoding": "identity"
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: historyPayload,
          stream: true
        })
      });

      console.log(`[OLLAMA HTTP RESPONSE] Status: ${response.status} ${response.statusText}`);

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let lineBuffer = "";
        let chunkCount = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkStr = decoder.decode(value, { stream: true });
          lineBuffer += chunkStr;

          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop(); // Retain unfinished line segment across stream reads

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const parsed = JSON.parse(trimmed);
              const chunkText = parsed.message?.content || parsed.response || "";
              if (chunkText) {
                accumulatedResponseText += chunkText;
                chunkCount++;
                res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
              }
            } catch (parseErr) {
              console.warn("⚠️ [OLLAMA STREAM PARSE NOTICE] Partial line skipped:", parseErr.message);
            }
          }
        }

        // Flush any trailing line left in buffer
        if (lineBuffer && lineBuffer.trim()) {
          try {
            const parsed = JSON.parse(lineBuffer.trim());
            const chunkText = parsed.message?.content || parsed.response || "";
            if (chunkText) {
              accumulatedResponseText += chunkText;
              chunkCount++;
              res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
            }
          } catch (e) {}
        }

        console.log(`[OLLAMA STREAM COMPLETED] Chunks received: ${chunkCount}, Total chars: ${accumulatedResponseText.length}`);

        if (accumulatedResponseText.trim()) {
          streamedSuccessfully = true;
          await Message.create({
            chatId,
            role: "assistant",
            content: accumulatedResponseText,
          });

          res.write("data: [DONE]\n\n");
          return res.end();
        }
      } else {
        const errorText = await response.text();
        console.error(`❌ [OLLAMA REJECTED REQUEST] HTTP ${response.status}: ${errorText}`);
      }
    } catch (ollamaErr) {
      console.warn("⚠️ [GENERAL CHAT LLM] Local Ollama service offline or error:", ollamaErr.message);
    }

    if (!streamedSuccessfully) {
      console.warn("⚠️ [FALLBACK EXECUTED] Ollama request failed or returned empty content. Sending fallback text.");
      const fallbackText = "I am ready to help you with coding, health, science, news, education, research, and productivity! Please ensure your local Ollama service is running.";
      await streamTextInChunks(res, fallbackText, 15);
      await Message.create({
        chatId,
        role: "assistant",
        content: fallbackText,
      });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  } catch (error) {
    console.error("General Chat Pipeline Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "General chat processing failed.", error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Stream connection error." })}\n\n`);
      res.end();
    }
  }
};