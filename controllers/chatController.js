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

function generateContextualFallback(userMessage, history = []) {
  const msgLower = (userMessage || "").trim().toLowerCase();

  // 1. Greetings
  if (/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|hey there|hi there)\b/i.test(msgLower)) {
    const greetings = [
      "Hi! How's your day going?",
      "Hello! What's on your mind today?",
      "Hey! Nice to chat with you. How can I help you right now?"
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // 2. Jokes (flexible match for "joke", "jokes", "funny")
  if (/\b(joke|jokes|funny)\b/i.test(msgLower)) {
    const jokes = [
      "Why don't scientists trust atoms? Because they make up everything!",
      "Why did the developer go broke? Because he used up all his cache!",
      "What do you call a fake noodle? An impasta!",
      "Why do Java programmers wear glasses? Because they don't C#!",
      "What do you call a sleeping dinosaur? A dino-snore!",
      "Why did the scarecrow win an award? Because he was outstanding in his field!"
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // 3. Boredom
  if (/\b(bored|boredom|entertain me)\b/i.test(msgLower)) {
    const boredTopics = [
      "Here's a mind-blowing fact: Did you know that honey never spoils? Archaeologists have found 3,000-year-old jars of honey in Egyptian tombs that are still perfectly edible! Want a fun riddle, or should we chat about something else?",
      "If you're looking for a quick riddle: What has keys but can't open locks, space but no room, and allows you to enter but not go outside? (Hint: You're using one right now!)",
      "Let me share an interesting trivia question: Do you know which animal has the largest brain of any creature on Earth?"
    ];
    return boredTopics[Math.floor(Math.random() * boredTopics.length)];
  }

  // 4. Follow-up / Short continuations ("anything is ok", "why?", "how?", "tell me more", "anything else?")
  const isFollowUp = /^(anything is ok|anything|why\??|how\??|anything else\??|tell me more|what else\??|go on|continue|sure|ok|okay)\b/i.test(msgLower);

  if (isFollowUp && history.length > 0) {
    const lastMsg = [...history].reverse().find(m => m.content && !m.content.includes("I am ready to help"));
    const contextSnippet = lastMsg ? lastMsg.content : "";

    if (/\b(joke|funny)\b/i.test(contextSnippet)) {
      return "Here's another one for you: Why did the computer take a nap? Because it needed to refresh its memory!";
    }

    if (/\b(pain|health|headache|fever|doctor|symptom|stomach)\b/i.test(contextSnippet)) {
      return "Continuing on that health topic: Staying well-hydrated, getting adequate rest, and avoiding stress are key supportive steps. If symptoms persist or feel severe, it's always best to consult a medical professional for a proper checkup.";
    }

    if (contextSnippet) {
      return `Continuing our conversation on that topic: there are several great directions we can explore next. Would you like a practical example, key principles, or fun trivia?`;
    }
  }

  // 5. Capability questions
  if (/what can you do|what are your capabilities|who are you/i.test(msgLower)) {
    return "I can assist you with coding, answering questions, writing, brainstorming, health & science inquiries, general topics, and productivity. What would you like to explore?";
  }

  // 6. Health & Medical inquiries
  if (/(headache|fever|cough|pain|stomach|doctor|medicine|health|sick|blood pressure|symptom)/i.test(msgLower)) {
    return `When dealing with ${msgLower.includes("stomach") ? "stomach pain" : "health symptoms"}, common factors can include indigestion, dehydration, muscle strain, or mild infections. Resting, sipping water, and eating light foods often helps. However, if pain is sharp or persistent, consulting a healthcare professional is strongly recommended.`;
  }

  // 7. Natural Conversational Fallback (NO template framing, NO asking for clarification)
  return `That's an interesting topic! There are a few different ways to approach this. We can explore practical steps, dive into background details, or look at a specific example. Which direction sounds best to you?`;
}

// -----------------------------------------------------------------------------
// 1. GENERAL CHAT DATABASE MANAGEMENT (CRUD)
// -----------------------------------------------------------------------------

exports.createChat = async (req, res) => {
  try {
    const chat = await Chat.create({
      userId: req.user.id,
      title: "New Conversation",
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
// 2. UNRESTRICTED GENERAL CHAT ENGINE WITH FULL CONVERSATION MEMORY (OLLAMA-NATIVE)
// -----------------------------------------------------------------------------

exports.sendMessage = async (req, res) => {
  const reqStartTime = performance.now();
  let dbFetchTime = 0;
  let modelResolveTime = 0;
  let ttft = null;
  let streamDuration = 0;
  let firstTokenTimestamp = null;
  let llmRequestStartTime = null;

  try {
    const { message } = req.body;
    let chatId = req.params.chatId;

    if (!message) {
      return res.status(400).json({ success: false, message: "Message text is required." });
    }

    const tDbStart = performance.now();
    let chat;
    if (!chatId || chatId === "new" || chatId === "undefined" || chatId === "null") {
      chat = await Chat.create({
        userId: req.user.id,
        title: message.trim().substring(0, 35) || "New Conversation",
      });
      chatId = chat._id;
    } else {
      chat = await Chat.findById(chatId);
    }

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat session not found." });
    }

    // Persist first user message as title for future sessions
    if (!chat.title || chat.title === "New Conversation" || chat.title === "New Chat" || chat.title === "General Chat") {
      chat.title = message.trim().substring(0, 35) || "New Conversation";
      await chat.save();
    }

    // Save User message
    await Message.create({ chatId, role: "user", content: message });

    // Update rolling summary if total messages >= 20
    const summaryText = await updateRollingSummaryIfNeeded(chat, chatId);

    // Fetch last 16 messages (8 turns) for deep multi-turn conversation memory
    const dbMessagesHistory = await Message.find({ chatId }).sort({ createdAt: -1 }).limit(16);
    dbMessagesHistory.reverse();

    dbFetchTime = performance.now() - tDbStart;

    // Unified System Instruction Block merging Core Guidelines and Conversation Summary
    let unifiedSystemPrompt = `You are a helpful, intelligent, highly capable conversational AI assistant like ChatGPT and Gemini.

CRITICAL INSTRUCTIONS:
- Directly, accurately, and naturally answer the user's latest question or prompt.
- NEVER output generic filler like "That's an interesting topic..." or "There are a few different ways to approach this...".
- Factual & Technical Queries: When asked direct questions (e.g. "What is React?", "What is Node.js?", coding, health, science), provide immediate, detailed, structured explanations.
- Jokes: When asked for a joke, tell an actual funny joke immediately.
- Follow-ups & Memory: Use the preceding conversation history and summary to maintain multi-turn context. When the user asks "why?", "how?", "any other reasons?", or short follow-ups, continue the previous topic seamlessly.
- Tone: Natural, friendly, helpful, and concise.`;

    if (summaryText && summaryText.trim()) {
      unifiedSystemPrompt += `\n\n[CONVERSATION SUMMARY SO FAR]\n${summaryText}`;
    }

    // Assemble clean, single-system-prompt context window payload for Ollama
    const historyPayload = [
      {
        role: "system",
        content: unifiedSystemPrompt
      }
    ];

    dbMessagesHistory.forEach((msg) => {
      // Exclude legacy connection error fallbacks to prevent LLM context contamination
      if (
        msg.role === "assistant" &&
        typeof msg.content === "string" &&
        (msg.content.includes("I am ready to help") ||
          msg.content.includes("interesting topic") ||
          msg.content.includes("Please check that your Ollama service is running"))
      ) {
        return;
      }
      historyPayload.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(`data: ${JSON.stringify({ type: "meta", chatId, title: chat.title })}\n\n`);

    const { selectBestClusterNode, clusterState } = require("../utils/ollamaHelper");
    const tModelStart = performance.now();
    const selectedNode = selectBestClusterNode();
    selectedNode.activeRequests++;

    const OLLAMA_BASE_URL = selectedNode.url;
    const targetModel = selectedNode.defaultModel;
    modelResolveTime = performance.now() - tModelStart;

    // Logging: Ollama Request Payload
    console.log(`\n=================== [OLLAMA CLUSTER DISPATCH REQUEST] ===================`);
    console.log(`Dispatched Node: ${selectedNode.id} (${selectedNode.name})`);
    console.log(`Target URL: ${selectedNode.url} (${selectedNode.format.toUpperCase()} API)`);
    console.log(`Active Requests on Node: ${selectedNode.activeRequests}`);
    console.log(`Target Model: ${targetModel}`);
    console.log(`Chat ID: ${chatId}`);
    console.log(`Payload Message Count: ${historyPayload.length}`);
    console.log(`Current User Prompt: "${message}"`);
    console.log(`========================================================================\n`);

    let accumulatedResponseText = "";
    let streamedSuccessfully = false;

    llmRequestStartTime = performance.now();

    try {
      const endpointPath = selectedNode.format === "openai" ? "/v1/chat/completions" : "/api/chat";
      const requestPayload = {
        model: targetModel,
        messages: historyPayload,
        stream: true
      };
      if (selectedNode.format === "ollama") {
        requestPayload.keep_alive = "24h";
      }

      let response = await fetch(`${selectedNode.url}${endpointPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/event-stream"
        },
        body: JSON.stringify(requestPayload)
      });

      // FALLBACK FAILOVER ROUTING IF PRIMARY NODE IS BUSY/OFFLINE
      if (!response.ok) {
        console.warn(`⚠️ [CLUSTER FAILOVER] ${selectedNode.id} HTTP ${response.status}. Attempting secondary node failover...`);
        const fallbackNode = clusterState.find(n => n.id !== selectedNode.id);
        if (fallbackNode) {
          const fallbackPath = fallbackNode.format === "openai" ? "/v1/chat/completions" : "/api/chat";
          response = await fetch(`${fallbackNode.url}${fallbackPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: fallbackNode.defaultModel,
              messages: historyPayload,
              stream: true
            })
          });
        }
      }

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
          lineBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const jsonStr = trimmed.startsWith("data: ") ? trimmed.replace("data: ", "").trim() : trimmed;
            if (jsonStr === "[DONE]") continue;

            try {
              const parsed = JSON.parse(jsonStr);
              const chunkText = parsed.message?.content || parsed.response || parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || "";
              if (chunkText) {
                if (!firstTokenTimestamp) {
                  firstTokenTimestamp = performance.now();
                  ttft = firstTokenTimestamp - llmRequestStartTime;
                }
                accumulatedResponseText += chunkText;
                chunkCount++;
                res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
              }
            } catch (parseErr) {}
          }
        }

        const totalDuration = performance.now() - reqStartTime;
        if (firstTokenTimestamp) {
          streamDuration = performance.now() - firstTokenTimestamp;
        }

        console.log(`
⏱️  =================== [GENERAL CHAT LATENCY DIAGNOSTICS] ===================
  📌 Route: General Chat Stream (/chats/${chatId}/messages)
  ├── 🌐 Dispatched Cluster Node:       ${selectedNode.id} (${selectedNode.name})
  ├── 🗄️ Database Operations:          ${dbFetchTime.toFixed(2)} ms
  ├── 🔎 Model & Node Discovery:        ${modelResolveTime.toFixed(2)} ms
  ├── 🚀 Time To First Token (TTFT):   ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A (Ollama Delay/Error)'}
  ├── ⚡ Token Streaming Duration:     ${streamDuration > 0 ? streamDuration.toFixed(2) + ' ms' : 'N/A'}
  └── 🏁 TOTAL REQUEST DURATION:        ${totalDuration.toFixed(2)} ms
========================================================================\n
`);

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
      }
    } catch (ollamaErr) {
      console.error("CRITICAL: Ollama cluster connection error:", ollamaErr.message);
    } finally {
      selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);
    }

    if (!streamedSuccessfully) {
      console.warn("⚠️ [OLLAMA OFFLINE NOTICE] Ollama request failed or returned empty content.");
      const fallbackText = "I'm unable to connect to the local AI model right now. Please check that your Ollama service is running and accessible.";
      await streamTextInChunks(res, fallbackText, 15);
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