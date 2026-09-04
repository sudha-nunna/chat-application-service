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
  let ttft = null;
  let streamDuration = 0;
  let firstTokenTimestamp = null;
  let llmRequestStartTime = null;

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

    // 3. Credit Reservation Pre-check (Floor: 0.05 credits)
    const MINIMUM_CHARGE_FLOOR = 0.05;
    if (currentBalance < MINIMUM_CHARGE_FLOOR) {
      return res.status(402).json({
        success: false,
        error: "INSUFFICIENT_CREDITS",
        message: "You have exhausted your credits. Please purchase a credit pack to continue chatting.",
        requiredCredits: MINIMUM_CHARGE_FLOOR,
        availableCredits: currentBalance,
        isPaidUser: isPaid
      });
    }

    let chat = chatDoc;
    if (!chat) {
      chat = await Chat.create({ userId, title: message.trim().substring(0, 35) || "New Conversation" });
    }
    chatId = chat._id;

    // Process file attachments (Images, PDF, TXT)
    const pdfParse = require("pdf-parse");
    const processedAttachments = [];
    let extractedTextContext = "";

    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      for (const att of rawAttachments) {
        const cleanData = (att.data || "").replace(/^data:.*?;base64,/, "");
        const fileBuffer = Buffer.from(cleanData, "base64");
        let fileText = "";

        const isPdf = att.fileType === "pdf" || att.mimeType === "application/pdf" || att.name?.endsWith(".pdf");
        const isTxt = att.fileType === "txt" || att.mimeType?.startsWith("text/") || att.name?.endsWith(".txt") || att.name?.endsWith(".md") || att.name?.endsWith(".json") || att.name?.endsWith(".csv");
        const isImg = att.fileType === "image" || att.mimeType?.startsWith("image/");

        const fileType = isImg ? "image" : isPdf ? "pdf" : "txt";

        if (isPdf && fileBuffer.length > 0) {
          try {
            const pdfData = await pdfParse(fileBuffer);
            fileText = pdfData.text || "";
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
          extractedTextContext += `\n\n[ATTACHED DOCUMENT: ${att.name}]\n${fileText.slice(0, 12000)}\n[END OF DOCUMENT: ${att.name}]`;
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
    let unifiedSystemPrompt = `You are a helpful, highly capable, articulate, and intelligent AI Assistant.

STRICT IDENTITY RULES:
1. Your name is "AI Assistant".
2. You must NEVER identify as, state, or claim to be "ChatGPT", "OpenAI", "Gemini", "Google", "Ollama", "Claude", "LLaMA", or any underlying AI vendor.
3. If asked about your name, identity, or creator, introduce yourself simply and warmly: "I am AI Assistant, your dedicated workspace helper."

CORE BEHAVIOR RULES:
1. Be direct, natural, engaging, and articulate.
2. For casual, open-ended, or greeting prompts (e.g., "tell me something", "what's up", "tell me a story"), provide an interesting, engaging, or thought-provoking answer right away, and warmly ask how you can help them today.
3. NEVER output robotic filler phrases like "It seems like you might have misinterpreted my previous response" or "I am an AI language model".
4. For technical, coding, science, or factual queries, provide detailed, accurate, beautifully formatted markdown explanations with bullet points and code blocks.
5. Maintain natural multi-turn conversation flow by using the conversation history seamlessly.`;

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
    const finalUserPrompt = extractedTextContext ? `${promptForAI}\n${extractedTextContext}` : promptForAI;
    historyPayload.push({ role: "user", content: finalUserPrompt });

    await saveUserMsgPromise;

    const userPriority = isPaid ? 100 : 50;
    const jobId = `general_${chatId}_${Date.now()}`;
    llmRequestStartTime = performance.now();

    console.log(`\n================================================================================`);
    console.log(`📥 [USER REQUEST RECEIVED IN BACKEND]`);
    console.log(`  • ChatId:       ${chatId}`);
    console.log(`  • User:         ${userId} (${isPaid ? "Paid Tier" : "Free Tier"})`);
    console.log(`  • Model:        ${currentModelId} (Provider: ${modelPricing.provider || "auto"})`);
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

    const gatewayResult = await aiGateway.generateStream({
      provider: modelPricing.provider || "auto",
      model: currentModelId,
      messages: historyPayload,
      attachments: processedAttachments,
      res,
      userPriority,
      jobId,
      userId: req.user.id,
      onToken: () => {
        if (!firstTokenTimestamp) {
          firstTokenTimestamp = performance.now();
          ttft = firstTokenTimestamp - llmRequestStartTime;
        }
      }
    });

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
      streamedSuccessfully = true;

      const saveAssistantPromise = Message.create({ chatId, role: "assistant", content: accumulatedResponseText });
      updateRollingSummaryIfNeeded(chat, chatId).catch(() => {});

      // 5. Post-Stream Atomic Credit Deduction & Async Telemetry Logging
      try {
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          { $inc: { credits: -calculatedCredits } },
          { new: true }
        );

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
          res.write(`data: ${JSON.stringify({
            type: "credit_update",
            creditsRemaining: remainingCredits,
            creditsConsumed: calculatedCredits,
            promptTokens,
            completionTokens,
            totalTokens,
            isPaidUser: isPaid,
            modelId: currentModelId
          })}\n\n`);
        }
      } catch (creditErr) {
        console.warn("⚠️ [CREDIT CONSUMPTION ERROR]", creditErr.message);
      }

      await saveAssistantPromise;

      console.log(`\n================================================================================`);
      console.log(`📤 [AI RESPONSE SENT TO USER]`);
      console.log(`  • ChatId:         ${chatId}`);
      console.log(`  • Model:          ${currentModelId}`);
      console.log(`  • Total Tokens:   ${totalTokens} (${promptTokens} prompt + ${completionTokens} completion)`);
      console.log(`  • Latency:        ${totalDuration.toFixed(2)} ms (TTFT: ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A'})`);
      console.log(`  • Response Length: ${accumulatedResponseText.length} characters`);
      console.log(`  • Response Text:`);
      console.log(accumulatedResponseText);
      console.log(`================================================================================\n`);

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    if (!streamedSuccessfully) {
      if (res.writableEnded) return;
      console.warn("⚠️ [AI GATEWAY NOTICE] Stream failed or returned empty content.");
      const fallbackText = gatewayResult.errorMessage || "I'm unable to connect to the active AI server node right now. Please check that your server node is running and accessible.";

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
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "General chat processing failed.", error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Stream connection error." })}\n\n`);
      res.end();
    }
  }
};