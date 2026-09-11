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
    res.write(`data: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
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

exports.stopMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { content } = req.body;

    if (!chatId) {
      return res.status(400).json({ success: false, message: "chatId is required." });
    }

    const lastMsg = await Message.findOne({ chatId }).sort({ createdAt: -1 });

    if (lastMsg && lastMsg.role === "assistant") {
      if (content && typeof content === "string") {
        lastMsg.content = content;
      }
      lastMsg.isStoppedMidway = true;
      if (!lastMsg.followUps || lastMsg.followUps.length === 0) {
        try {
          const followUpService = require("../services/followUpService");
          lastMsg.followUps = followUpService.getSmartFollowUps("", lastMsg.content);
        } catch (e) {}
      }
      await lastMsg.save();
      return res.json({ success: true, message: lastMsg });
    } else if (content && typeof content === "string" && content.trim()) {
      let smartFollowUps = [];
      try {
        const followUpService = require("../services/followUpService");
        smartFollowUps = followUpService.getSmartFollowUps(lastMsg?.role === "user" ? lastMsg.content : "", content.trim());
      } catch (e) {}
      const newMsg = await Message.create({
        chatId,
        role: "assistant",
        content: content.trim(),
        isStoppedMidway: true,
        followUps: smartFollowUps || []
      });
      return res.json({ success: true, message: newMsg });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Failed to mark message stopped:", error.message);
    return res.status(500).json({ success: false, message: error.message });
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

exports.updateChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ success: false, message: "Chat title cannot be empty." });
    }

    const userId = req.user?.id || req.user?._id;
    const query = { _id: chatId };
    if (userId) {
      query.userId = userId;
    }

    const updatedChat = await Chat.findOneAndUpdate(
      query,
      { title: title.trim() },
      { returnDocument: "after" }
    );

    if (!updatedChat) {
      return res.status(404).json({ success: false, message: "Chat not found or unauthorized." });
    }

    res.json(updatedChat);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    await Promise.all([
      Chat.findByIdAndDelete(chatId),
      Message.deleteMany({ chatId }),
      Summary.deleteOne({ chatId })
    ]);

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
  let ttft = null;
  let streamDuration = 0;
  let firstTokenTimestamp = null;
  let llmRequestStartTime = null;
  let clientDisconnected = false;
  req.on("aborted", () => {
    clientDisconnected = true;
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
    }
  });

  try {
    let { message } = req.body;
    let chatId = req.params.chatId;
    const rawAttachments = req.body.attachments || [];

    const hasAttachments = Array.isArray(rawAttachments) && rawAttachments.length > 0;
    const hasMessage = typeof message === "string" && message.trim().length > 0;

    if (!hasMessage) {
      return res.status(400).json({ success: false, message: "A text prompt is required with your submission." });
    }

    const rawUserMessage = hasMessage ? message.trim() : "";
    const hasImage = hasAttachments && rawAttachments.some(a => a.fileType === "image" || a.mimeType?.startsWith("image/"));

    const tDbStart = performance.now();
    const userId = req.user?.id || req.user?._id;
    const todayStr = new Date().toISOString().split("T")[0];
    const requestedModelId = req.body.model || req.body.modelId || "auto";

    const aiGateway = require("../utils/aiGateway");
    const User = require("../models/User");
    const CreditTransaction = require("../models/CreditTransaction");
    const ModelUsage = require("../models/ModelUsage");
    const Usage = require("../models/Usage");

    const isExistingChat = chatId && chatId !== "new" && chatId !== "undefined" && chatId !== "null";

    // ✅ Promise.all Parallel DB & Pricing Cache Queries (Runs in 1 IO tick)
    const [userDoc, userUsageToday, modelPricing, chatDoc, dbMessagesHistory] = await Promise.all([
      User.findById(userId),
      Usage.findOne({ userId, date: todayStr }),
      aiGateway.getModelPricingCached(requestedModelId),
      isExistingChat ? Chat.findById(chatId) : Chat.create({ userId, title: message.trim().substring(0, 35) || "New Conversation" }),
      isExistingChat ? Message.find({ chatId }).sort({ createdAt: -1 }).limit(16) : Promise.resolve([])
    ]);

    dbFetchTime = performance.now() - tDbStart;

    // 1. Resolve User & Plan
    if (!userDoc) {
      return res.status(401).json({ success: false, message: "User account not found." });
    }
    const isPaid = Boolean(userDoc.isPaidUser || userDoc.totalCreditsPurchased > 0);
    const currentBalance = typeof userDoc.credits === "number" ? userDoc.credits : 0;

    // 2. Daily Message Limit (Strictly for Free Tier users: 50 msgs/day)
    const messagesSentToday = userUsageToday?.messagesUsedToday || 0;
    if (!isPaid) {
      const FREE_DAILY_LIMIT = 50;
      if (messagesSentToday >= FREE_DAILY_LIMIT) {
        return res.status(429).json({
          success: false,
          error: "DAILY_FREE_LIMIT_REACHED",
          message: "You have reached your daily free tier limit of 50 messages. Purchase credits to unlock unlimited daily messages.",
          dailyLimit: FREE_DAILY_LIMIT,
          messagesUsedToday: messagesSentToday,
          isPaidUser: false
        });
      }
    }

    // 3. Upfront Atomic Credit Reservation (Floor: 0.05 credits) to prevent negative balance bypass
    const MINIMUM_CHARGE_FLOOR = 0.05;
    const reservedAmount = MINIMUM_CHARGE_FLOOR;
    let creditReserved = false;

    const reservedUser = await User.findOneAndUpdate(
      { _id: userId, credits: { $gte: MINIMUM_CHARGE_FLOOR } },
      { $inc: { credits: -reservedAmount } },
      { returnDocument: "after" }
    );

    if (!reservedUser) {
      return res.status(402).json({
        success: false,
        error: "INSUFFICIENT_CREDITS",
        message: "You have exhausted your credits. Please purchase a credit pack to continue chatting.",
        requiredCredits: MINIMUM_CHARGE_FLOOR,
        availableCredits: currentBalance,
        isPaidUser: isPaid
      });
    }
    creditReserved = true;

    let chat = chatDoc;
    if (!chat) {
      chat = await Chat.create({ userId, title: message.trim().substring(0, 35) || "New Conversation" });
    }
    chatId = chat._id;

    // Process file attachments (Images, PDF, TXT)
    const { extractPdfText } = require("../services/pdfExtractionService");
    const processedAttachments = [];
    let extractedTextContext = "";

    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      for (const att of rawAttachments) {
        const cleanData = (att.data || "").replace(/^data:.*?;base64,/, "");
        const fileBuffer = Buffer.from(cleanData, "base64");
        let fileText = "";

        const isPdf = att.fileType === "pdf" || att.mimeType === "application/pdf" || att.name?.toLowerCase().endsWith(".pdf");
        const isTxt = att.fileType === "txt" || att.mimeType?.startsWith("text/") || att.name?.toLowerCase().endsWith(".txt") || att.name?.toLowerCase().endsWith(".md") || att.name?.toLowerCase().endsWith(".json") || att.name?.toLowerCase().endsWith(".csv");
        const isImg = att.fileType === "image" || att.mimeType?.startsWith("image/");

        const fileType = isImg ? "image" : isPdf ? "pdf" : "txt";

        if (isPdf && fileBuffer.length > 0) {
          try {
            fileText = await extractPdfText(fileBuffer);
            console.log(`📄 [PDF EXTRACTED] File: ${att.name}, Length: ${fileText.length} chars`);
          } catch (pdfErr) {
            console.warn("⚠️ PDF text extraction warning:", pdfErr.message);
          }
        } else if (isTxt && fileBuffer.length > 0) {
          fileText = fileBuffer.toString("utf-8");
        }

        processedAttachments.push({
          name: att.name || "attachment",
          fileType,
          mimeType: att.mimeType || (isImg ? "image/png" : isPdf ? "application/pdf" : "text/plain"),
          data: cleanData,
          size: att.size || fileBuffer.length,
          extractedText: fileText
        });

        if (fileText.trim()) {
          extractedTextContext += `\n\n[ATTACHED DOCUMENT: ${att.name}]\n${fileText.slice(0, 32000)}\n[END OF DOCUMENT: ${att.name}]`;
        } else if (isPdf) {
          extractedTextContext += `\n\n[ATTACHED DOCUMENT: ${att.name}]\n(Document attached: ${att.name}, size: ${Math.round(fileBuffer.length / 1024)}KB. If text is unreadable, it may be a scanned image or protected PDF.)\n[END OF DOCUMENT: ${att.name}]`;
        }
      }
    }

    // Save User message with attachments & update title (only store text user actually typed!)
    const saveUserMsgPromise = Message.create({
      chatId,
      role: "user",
      content: rawUserMessage,
      attachments: processedAttachments.map(({ extractedText, ...rest }) => rest)
    });

    if (!chat.title || chat.title === "New Conversation" || chat.title === "New Chat" || chat.title === "General Chat") {
      const defaultTitle = hasImage ? "Image Analysis" : "Document Analysis";
      chat.title = rawUserMessage.substring(0, 35) || defaultTitle;
      chat.save().catch(() => {});
    }

    const historyMsgs = (dbMessagesHistory || []).slice().reverse();

    // 4. Resolve Model Pricing & Fast SSE Header Flush
    const promptRate = modelPricing.promptTokenCostPer1k ?? 0.05;
    const completionRate = modelPricing.completionTokenCostPer1k ?? 0.1;
    const currentModelId = modelPricing.modelId || requestedModelId;

    // Set SSE headers ONCE after pre-flight validations pass
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    if (res.socket && typeof res.socket.setNoDelay === "function") {
      res.socket.setNoDelay(true);
    }

    res.write(`data: ${JSON.stringify({
      type: "meta",
      chatId,
      title: chat.title,
      model: currentModelId,
      modelName: modelPricing.displayName || currentModelId,
      minCharge: MINIMUM_CHARGE_FLOOR,
      promptTokenCostPer1k: promptRate,
      completionTokenCostPer1k: completionRate,
      isPaidUser: isPaid
    })}\n\n`);

    const summaryText = chat.conversationSummary || "";
    const now = new Date();
    const currentDateFormatted = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    });
    const currentTimeFormatted = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      timeZone: "UTC"
    });

    let unifiedSystemPrompt = `You are a helpful, highly capable, articulate, and intelligent AI Assistant.

TEMPORAL CONTEXT:
• Current Real-World Date: ${currentDateFormatted}
• Current Time (UTC): ${currentTimeFormatted}
Always use this authoritative real-world date reference when answering current date, day, month, year, or calendar queries.

STRICT IDENTITY RULES:
1. Your name is "Codegene AI".
2. You must NEVER identify as, state, or claim to be "ChatGPT", "OpenAI", "Gemini", "Google", "Ollama", "Claude", "LLaMA", or any underlying AI vendor.
3. If asked about your name, identity, or creator, introduce yourself simply and warmly: "I am Codegene AI, your dedicated workspace helper."

CORE BEHAVIOR & OUTPUT FORMAT RULES:
1. Be direct, natural, engaging, and articulate. Jump straight into the helpful, accurate answer.
2. NEVER output your internal drafting process, brainstorm notes, planning steps, or meta-commentary (such as "Draft:", "Structure:", "Hook:", or "Since the date is..."). Output ONLY the final, polished response directly to the user.
3. For casual, open-ended, or greeting prompts, provide an interesting, engaging, or thought-provoking answer right away, and warmly ask how you can help them today.
4. NEVER output robotic filler phrases like "It seems like you might have misinterpreted my previous response" or "I am an AI language model".
5. For ALL coding, React, Vite, and web development tasks, every generated file MUST explicitly specify its exact relative path (e.g., "src/components/NavBar.jsx", "src/pages/Home.jsx", "src/services/countryService.js", "src/components/NavBar.css").
   CRITICAL REQUIREMENT: Every file imported anywhere in the application MUST be physically generated in the project files. Never omit stylesheets, hooks, utility modules, or component files that are imported in code.
6. When using JSON Action Protocol or markdown file headers, ensure every file path is fully qualified (e.g. "src/components/NavBar.jsx"). Do not concatenate multiple files into one. Maintain natural multi-turn conversation flow by using the conversation history seamlessly.`;

    if (summaryText && summaryText.trim()) {
      unifiedSystemPrompt += `\n\n[CONVERSATION SUMMARY SO FAR]\n${summaryText}`;
    }

    const historyPayload = [{ role: "system", content: unifiedSystemPrompt }];
    historyMsgs.forEach((msg) => {
      if (
        msg.role === "assistant" &&
        typeof msg.content === "string" &&
        (msg.content.includes("I am ready to help") ||
          msg.content.includes("misinterpreted my previous response") ||
          msg.content.includes("I'm here to help and provide information") ||
          msg.content.includes("Please check that your Ollama service is running"))
      ) {
        return;
      }
      historyPayload.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    });

    const promptForAI = rawUserMessage || (hasImage ? "Please analyze this image and describe what it contains." : "Please analyze the attached document.");
    let finalUserPrompt = extractedTextContext ? `${promptForAI}\n${extractedTextContext}` : promptForAI;

    // Code RAG Engine: Prune multi-file project workspace files to fit LLM token budget
    if (req.body.projectFiles && Array.isArray(req.body.projectFiles) && req.body.projectFiles.length > 0) {
      try {
        const { selectRelevantServerFiles, formatFilesForPrompt } = require("../utils/codeRAGServerEngine");
        const prunedFiles = selectRelevantServerFiles(req.body.projectFiles, rawUserMessage, 16000);
        const formattedCodeContext = formatFilesForPrompt(prunedFiles);
        finalUserPrompt += `\n\n[MULTI-FILE VFS CONTEXT (${prunedFiles.length} of ${req.body.projectFiles.length} files relevant)]\n${formattedCodeContext}`;
      } catch (ragErr) {
        console.warn("⚠️ Code RAG pruning error:", ragErr.message);
      }
    }

    // Web Search Flag: Only execute web search when explicitly requested by user
    const enableSearch = Boolean(
      req.body.enableSearch || req.body.webSearch || req.body.internetSearch
    );

    // Pre-resolve best cluster node for node consistency between search & generation
    const { selectBestClusterNode } = require("../utils/ollamaHelper");
    const userPriority = isPaid ? 100 : 50;
    const preResolvedNodeHint = selectBestClusterNode(userPriority);

    // Evaluate smart search intent (< 0.1ms synchronous rule-based guardrail)
    const { evaluateSearchIntent } = require("../services/searchIntentService");
    const searchIntent = evaluateSearchIntent(rawUserMessage, enableSearch, {
      hasHistory: Array.isArray(dbMessagesHistory) && dbMessagesHistory.length > 0,
      hasAttachments: Array.isArray(processedAttachments) && processedAttachments.length > 0
    });

    let searchExecuted = false;
    let searchSources = [];
    let isGuidanceActive = false;

    // Check if an Ollama Cloud node with an active secretKey exists for this model
    const { getProviderPools, refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    await refreshClusterNodesFromDB();
    const { allNodes } = getProviderPools();
    const cleanBaseModel = currentModelId.toLowerCase().replace(/:cloud$/, "").split(":")[0];
    const matchingOllamaCloudNode = enableSearch
      ? allNodes.find(n =>
          n.isActive !== false &&
          (n.format === "ollama" || n.url?.includes("ollama.com")) &&
          n.secretKey && n.secretKey.length > 5 &&
          !/[\u2022\*]/.test(n.secretKey) &&
          (
            n.url?.includes("ollama.com") ||
            (Array.isArray(n.supportedModels) && n.supportedModels.some(m =>
              m.toLowerCase() === currentModelId.toLowerCase() ||
              m.toLowerCase().startsWith(cleanBaseModel)
            ))
          )
        )
      : null;

    if (searchIntent.shouldSearch && rawUserMessage) {
      // If we don't have an agentic Ollama Cloud key, perform prefetch search upfront
      if (!matchingOllamaCloudNode) {
        try {
          const webSearchService = require("../services/webSearchService");
          const searchResult = await webSearchService.searchOrFetch(rawUserMessage);
          if (searchResult && searchResult.formattedContext) {
            finalUserPrompt = `${finalUserPrompt}\n\n${searchResult.formattedContext}`;
            searchExecuted = true;
            searchSources = searchResult.sources || [];
          }
        } catch (searchErr) {
          console.warn("⚠️ [SEARCH] Graceful skip on error:", searchErr.message);
        }
      }
    } else if (!enableSearch && rawUserMessage) {
      const { isTimeSensitiveQuery } = require("../services/searchIntentService");
      if (isTimeSensitiveQuery(rawUserMessage)) {
        isGuidanceActive = true;
        const guidanceInstruction = "\n\n[SYSTEM GUIDANCE: The user is asking for real-time live data, market prices, or current news, but Web Search is currently turned OFF in their chat settings. Explain politely that you do not have access to live real-time information in offline mode, and instruct them: 'Please switch on the 🌐 Web Search icon at the bottom of the chat to enable real-time internet search for this request.']";
        finalUserPrompt = `${finalUserPrompt}${guidanceInstruction}`;
      }
    }

    // Continuation intent detector: when user says "continue", "not done fully", "keep going", etc.
    const lastAssistantMsg = historyMsgs.filter((m) => m.role === "assistant").pop();
    const isContinuationIntent = /^(continue|carry on|go on|keep going|proceed|finish|finish it|finish the code|not done|it not done|see it not done|it is not done|not fully done|see it not done fully|complete it|complete the rest|build the rest)\b/i.test((rawUserMessage || "").trim());

    if (isContinuationIntent && lastAssistantMsg) {
      finalUserPrompt = `${finalUserPrompt}\n\n[CRITICAL CONTINUATION DIRECTIVE: The user is explicitly requesting to continue and fully finish their project or code ("${rawUserMessage.trim()}").
1. Do NOT state that you already finished or that the files are complete.
2. Do NOT say "It looks like you might be typing continue".
3. Do NOT ask clarifying questions like "Which section should I build first?" or "What would you like me to add next?".
4. Immediately proceed to write the next remaining sections and components (such as FeaturesSection.jsx, PricingSection.jsx, TestimonialsSection.jsx, Footer.jsx, etc.) and provide the updated App.jsx that integrates all components into a complete, working application. Output the full code blocks directly.]`;
    }

    historyPayload.push({ role: "user", content: finalUserPrompt });

    await saveUserMsgPromise;

    const jobId = `general_${chatId}_${Date.now()}`;
    llmRequestStartTime = performance.now();

    console.log(`\n================================================================================`);
    console.log(`📥 [USER REQUEST RECEIVED IN BACKEND]`);
    console.log(`  • ChatId:       ${chatId}`);
    console.log(`  • User:         ${userId} (${isPaid ? "Paid Tier" : "Free Tier"})`);
    console.log(`  • Model:        ${currentModelId} (Provider: ${modelPricing.provider || "auto"})`);
    console.log(`  • Web Search:   ${!enableSearch ? "Disabled (Normal Flow)" : matchingOllamaCloudNode ? "Active (Agentic Tool Loop via Ollama Cloud Key)" : searchExecuted ? `Active (Injected: ${searchIntent.reason})` : `Bypassed by Guardrail (${searchIntent.reason})`}`);
    console.log(`  • Prompt Message: "${rawUserMessage || (hasImage ? "[Attachment Only - Image Analysis]" : "[Attachment Only]")}"`);
    if (processedAttachments.length > 0) {
      console.log(`  • Attachments (${processedAttachments.length}):`);
      processedAttachments.forEach((att, i) => {
        console.log(`    [${i + 1}] ${att.name} (Type: ${att.fileType}, MIME: ${att.mimeType}, Size: ${att.size} bytes)`);
      });
    } else {
      console.log(`  • Attachments:  None`);
    }
    console.log(`================================================================================\n`);

    // Emit web search status or guidance event to frontend via SSE
    if (searchExecuted && searchSources.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "search_status", sources: searchSources, query: rawUserMessage })}\n\n`);
      if (typeof res.flush === "function") { try { res.flush(); } catch (e) {} }
    } else if (isGuidanceActive) {
      res.write(`data: ${JSON.stringify({ type: "search_guidance", requiresWebSearch: true, query: rawUserMessage })}\n\n`);
      if (typeof res.flush === "function") { try { res.flush(); } catch (e) {} }
    }

    let gatewayResult = null;

    // 1. Try Agentic Tool Search if matching Ollama Cloud node with secretKey exists
    if (matchingOllamaCloudNode) {
      try {
        let targetOllamaModel = currentModelId;
        if (Array.isArray(matchingOllamaCloudNode.supportedModels) && matchingOllamaCloudNode.supportedModels.length > 0) {
          const exactMatch = matchingOllamaCloudNode.supportedModels.find(m => m.toLowerCase() === currentModelId.toLowerCase());
          if (exactMatch) {
            targetOllamaModel = exactMatch;
          } else {
            const cleanPrefix = currentModelId.toLowerCase().replace(/:cloud$/, "").split(":")[0];
            const prefixMatch = matchingOllamaCloudNode.supportedModels.find(m => m.toLowerCase().startsWith(cleanPrefix));
            targetOllamaModel = prefixMatch || matchingOllamaCloudNode.defaultModel || currentModelId;
          }
        }

        console.log(`🚀 [OLLAMA TOOL SERVICE] Initiating agentic tool search with node "${matchingOllamaCloudNode.name}" (Model: ${targetOllamaModel})`);
        const ollamaToolService = require("../services/ollamaToolService");
        gatewayResult = await ollamaToolService.streamAgenticChat({
          model: targetOllamaModel,
          messages: historyPayload,
          node: matchingOllamaCloudNode,
          res,
          onToken: () => {
            if (!firstTokenTimestamp) {
              firstTokenTimestamp = performance.now();
              ttft = firstTokenTimestamp - llmRequestStartTime;
            }
          }
        });
      } catch (agenticErr) {
        console.warn(`⚠️ [AGENTIC TOOL SEARCH ERROR] Failed: ${agenticErr.message}. Falling back to standard gateway stream.`);
        gatewayResult = null;
      }
    }

    // 2. Standard Gateway Stream (Fallback or Default Path)
    if (!gatewayResult) {
      gatewayResult = await aiGateway.generateStream({
        provider: modelPricing.provider || "auto",
        model: currentModelId,
        messages: historyPayload,
        attachments: processedAttachments,
        res,
        userPriority,
        jobId,
        userId: req.user.id,
        preResolvedNodeHint,
        onToken: () => {
          if (!firstTokenTimestamp) {
            firstTokenTimestamp = performance.now();
            ttft = firstTokenTimestamp - llmRequestStartTime;
          }
        }
      });
    }

    let accumulatedResponseText = gatewayResult.text || "";
    let streamedSuccessfully = gatewayResult.success;

    const totalDuration = performance.now() - reqStartTime;
    if (firstTokenTimestamp) {
      streamDuration = performance.now() - firstTokenTimestamp;
    }

    const promptTokens = gatewayResult.promptTokens || 0;
    const completionTokens = gatewayResult.completionTokens || 0;
    const totalTokens = gatewayResult.totalTokens || (promptTokens + completionTokens);

    const rawCreditsUsed = (promptTokens / 1000 * promptRate) + (completionTokens / 1000 * completionRate);
    const calculatedCredits = Math.max(MINIMUM_CHARGE_FLOOR, parseFloat(rawCreditsUsed.toFixed(4)));

    console.log(`
⏱️  =================== [GENERAL CHAT LATENCY & TOKEN DIAGNOSTICS] ===================
  📌 Route: General Chat Stream (/chats/${chatId}/messages)
  ├── 🧠 Model Selected:               ${currentModelId}
  ├── 👤 User Tier:                    ${isPaid ? "Paid (Unlimited Daily)" : "Free (50 msgs/day)"}
  ├── 📊 Token Usage:                  ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total tokens
  ├── 💰 Credits Consumed:             ${calculatedCredits} cr (Min Floor: ${MINIMUM_CHARGE_FLOOR}, In Rate: ${promptRate}/1k, Out Rate: ${completionRate}/1k)
  ├── 🌐 Dispatched Cluster Node:       ${gatewayResult.nodeId || "Auto"}
  ├── 🗄️ Parallel DB Overhead:         ${dbFetchTime.toFixed(2)} ms
  ├── 🚀 Time To First Token (TTFT):   ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A'}
  ├── ⚡ Token Streaming Duration:     ${streamDuration > 0 ? streamDuration.toFixed(2) + ' ms' : 'N/A'}
  └── 🏁 TOTAL REQUEST DURATION:        ${totalDuration.toFixed(2)} ms
========================================================================\n
`);

    if (accumulatedResponseText.trim()) {
      // 5. Generate AI Follow-up Suggestions (if enabled in Admin System Settings)
      let followUps = [];
      try {
        const followUpService = require("../services/followUpService");
        followUps = await followUpService.generateFollowUps(
          rawUserMessage,
          accumulatedResponseText,
          {
            model: currentModelId,
            nodeId: gatewayResult?.nodeId,
            preResolvedNodeHint
          }
        );
      } catch (fErr) {
        console.warn("⚠️ [FOLLOW-UPS NOTICE] Generation skipped on error:", fErr.message);
      }

      let finalFollowUps = Array.isArray(followUps) && followUps.length > 0 ? followUps : [];
      if (finalFollowUps.length === 0) {
        try {
          const followUpService = require("../services/followUpService");
          finalFollowUps = followUpService.getSmartFollowUps(rawUserMessage, accumulatedResponseText);
        } catch (e) {}
      }

      const isStopped = (clientDisconnected || Boolean(req.destroyed)) && !res.writableEnded;
      const saveAssistantPromise = Message.create({
        chatId,
        role: "assistant",
        content: accumulatedResponseText,
        isStoppedMidway: isStopped,
        followUps: finalFollowUps || [],
        sources: searchSources,
        requiresWebSearch: isGuidanceActive
      });
      updateRollingSummaryIfNeeded(chat, chatId).catch(() => {});

      // 6. Post-Stream Atomic Credit Deduction & Async Telemetry Logging
      try {
        // Settle upfront reservation: adjust for remainder of calculated credits
        const creditAdjustment = calculatedCredits - reservedAmount;
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $inc: { credits: -creditAdjustment } },
          { returnDocument: "after" }
        );
        creditReserved = false;

        if (updatedUser) {
          const remainingCredits = Math.max(0, updatedUser.credits);

          // Asynchronous telemetry writes
          Promise.allSettled([
            CreditTransaction.create({
              userId: updatedUser._id,
              amount: -calculatedCredits,
              type: "AI_MESSAGE_CONSUMPTION",
              modelId: currentModelId,
              promptTokens,
              completionTokens,
              totalTokens,
              description: `${calculatedCredits} cr (${promptTokens} in / ${completionTokens} out tokens) for ${modelPricing.displayName || currentModelId}`,
              balanceAfter: remainingCredits,
              chatId: chat._id
            }),
            ModelUsage.create({
              userId: updatedUser._id,
              modelId: currentModelId,
              provider: modelPricing.provider || gatewayResult.provider || "auto",
              nodeId: gatewayResult.nodeId || "",
              responseTimeMs: Math.round(totalDuration),
              ttftMs: Math.round(ttft || 0),
              creditsUsed: calculatedCredits,
              promptTokens,
              completionTokens,
              status: "SUCCESS"
            }),
            Usage.findOneAndUpdate(
              { userId: updatedUser._id, date: todayStr },
              {
                $inc: {
                  messagesUsedToday: 1,
                  tokensUsedToday: totalTokens,
                  creditsUsedToday: calculatedCredits
                }
              },
              { upsert: true }
            )
          ]).catch(e => console.warn("⚠️ [TELEMETRY ERR]", e.message));

          // Emit live credit update to frontend
          if (!clientDisconnected && !res.writableEnded) {
            try {
              res.write(`data: ${JSON.stringify({
                type: "credit_update",
                creditsRemaining: remainingCredits,
                creditsConsumed: calculatedCredits,
                promptTokens,
                completionTokens,
                totalTokens,
                durationMs: Math.round(totalDuration),
                modelId: currentModelId
              })}\n\n`);
              if (typeof res.flush === "function") {
                try { res.flush(); } catch (e) {}
              }
            } catch (e) {}
          }
        }
      } catch (postStreamErr) {
        console.warn("Notice: Post-stream credit deduction telemetry warning:", postStreamErr.message);
      }

      // Emit follow-up suggestions event to frontend if generated
      if (!clientDisconnected && !res.writableEnded && Array.isArray(finalFollowUps) && finalFollowUps.length > 0) {
        try {
          res.write(`data: ${JSON.stringify({
            type: "follow_ups",
            followUps: finalFollowUps
          })}\n\n`);
          if (typeof res.flush === "function") {
            try { res.flush(); } catch (e) {}
          }
        } catch (e) {}
      }

      await saveAssistantPromise;

      console.log(`\n================================================================================`);
      console.log(`📤 [AI RESPONSE SENT TO USER]`);
      console.log(`  • ChatId:         ${chatId}`);
      console.log(`  • Model:          ${currentModelId}`);
      console.log(`  • Total Tokens:   ${totalTokens} (${promptTokens} prompt + ${completionTokens} completion)`);
      console.log(`  • Follow-ups:     ${finalFollowUps.length > 0 ? finalFollowUps.join(" | ") : "None"}`);
      console.log(`  • Latency:        ${totalDuration.toFixed(2)} ms (TTFT: ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A'})`);
      console.log(`  • Response Length: ${accumulatedResponseText.length} characters`);
      console.log(`  • Response Text:`);
      console.log(accumulatedResponseText);
      console.log(`================================================================================\n`);

      if (!clientDisconnected && !res.writableEnded) {
        try {
          res.write("data: [DONE]\n\n");
          if (typeof res.flush === "function") {
            try { res.flush(); } catch (e) {}
          }
          return res.end();
        } catch (e) {}
      }
      return;
    }

    if (!streamedSuccessfully) {
      // Refund upfront reserved credit if stream was unsuccessful
      if (creditReserved) {
        await User.findByIdAndUpdate(userId, { $inc: { credits: reservedAmount } }).catch(() => {});
        creditReserved = false;
      }
      if (res.writableEnded) return;
      console.warn("⚠️ [AI GATEWAY NOTICE] Stream failed or returned empty content.");
      const standardTrafficMsg = "I'm sorry, I am experiencing difficulty connecting at the moment due to high traffic. Please try again in a few minutes.";
      let fallbackText = gatewayResult?.userFriendlyMessage || standardTrafficMsg;
      if (!fallbackText || fallbackText.includes("HTTP 40") || fallbackText.includes("not found") || fallbackText.includes("errorBody") || fallbackText.includes("model '") || fallbackText.includes("{") || fallbackText.includes("returned HTTP")) {
        fallbackText = standardTrafficMsg;
      }

      console.log(`\n================================================================================`);
      console.log(`📤 [FALLBACK RESPONSE SENT TO USER]`);
      console.log(`  • ChatId:         ${chatId}`);
      console.log(`  • Fallback Text:`);
      console.log(fallbackText);
      console.log(`================================================================================\n`);

      await streamTextInChunks(res, fallbackText, 15);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  } catch (error) {
    console.error("General Chat Pipeline Error:", error);
    if (creditReserved) {
      await User.findByIdAndUpdate(userId, { $inc: { credits: reservedAmount } }).catch(() => {});
      creditReserved = false;
    }
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "General chat processing failed.", error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Stream connection error." })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  }
};
// -----------------------------------------------------------------------------
// Public / Authenticated Shared Chat Endpoints
// -----------------------------------------------------------------------------

/**
 * Marks a conversation as shared and returns the share timestamp.
 */
exports.shareChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await Chat.findOne({ _id: chatId, userId: req.user.id });
    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat not found or unauthorized." });
    }

    chat.isShared = true;
    chat.sharedAt = new Date();
    await chat.save();

    res.json({
      success: true,
      chatId: chat._id,
      isShared: true,
      sharedAt: chat.sharedAt
    });
  } catch (err) {
    console.error("Error sharing chat:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Retrieves a shared conversation for viewing by authenticated users.
 */
exports.getSharedChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await Chat.findById(chatId).populate("userId", "name email");
    if (!chat) {
      return res.status(404).json({ success: false, message: "Shared conversation not found." });
    }

    const currentUserId = (req.user?.id || req.user?._id || "").toString();
    const isOwner = chat.userId && chat.userId._id.toString() === currentUserId;

    if (!chat.isShared && !isOwner) {
      return res.status(403).json({ success: false, message: "This chat has not been shared by its author." });
    }

    const messages = await Message.find({ chatId }).sort({ createdAt: 1 });

    res.json({
      success: true,
      chat: {
        _id: chat._id,
        title: chat.title,
        createdAt: chat.createdAt,
        sharedAt: chat.sharedAt,
        author: {
          name: chat.userId?.name || "Codegene User",
          email: chat.userId?.email || ""
        },
        isOwner
      },
      messages
    });
  } catch (err) {
    console.error("Error getting shared chat:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Clones / Forks a shared chat into the viewing user's private chat list.
 */
exports.forkSharedChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const currentUserId = req.user?.id || req.user?._id;
    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Authentication required to fork chat." });
    }

    const originalChat = await Chat.findById(chatId);
    if (!originalChat) {
      return res.status(404).json({ success: false, message: "Chat not found." });
    }

    const isOwner = originalChat.userId.toString() === currentUserId.toString();
    if (!originalChat.isShared && !isOwner) {
      return res.status(403).json({ success: false, message: "This conversation has not been shared." });
    }

    // 1. Create duplicate chat for viewing user
    const newChat = await Chat.create({
      userId: currentUserId,
      title: `${originalChat.title || "Conversation"} (Copy)`,
      conversationSummary: originalChat.conversationSummary || ""
    });

    // 2. Clone all messages into the new chat
    const originalMessages = await Message.find({ chatId }).sort({ createdAt: 1 });
    if (originalMessages.length > 0) {
      const clonedDocs = originalMessages.map((msg) => ({
        chatId: newChat._id,
        role: msg.role,
        content: msg.content,
        attachments: msg.attachments || [],
        followUps: msg.followUps || [],
        sources: msg.sources || [],
        requiresWebSearch: msg.requiresWebSearch || false
      }));
      await Message.insertMany(clonedDocs);
    }

    res.json({
      success: true,
      newChatId: newChat._id,
      message: "Chat cloned successfully."
    });
  } catch (err) {
    console.error("Error forking chat:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
