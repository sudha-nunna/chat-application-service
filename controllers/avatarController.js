const Bot = require("../models/Bot");
const AvatarConversation = require("../models/AvatarConversation");
const AvatarMessage = require("../models/AvatarMessage");
const BotConversation = require("../models/BotConversation");
const BotMessage = require("../models/BotMessage");
const BotFile = require("../models/BotFile");
const aiGateway = require("../utils/aiGateway");
const { detectBotIntent, buildRagSystemPrompt, buildGeneralSystemPrompt, retrieveRelevantChunks } = require("../utils/ragEngine");
const { getCache, setCache } = require("../utils/redisClient");
const { calculatePriority } = require("../utils/priorityCalculator");
const voiceService = require("../services/voiceService");

/**
 * handleAvatarChat
 * Dedicated endpoint: POST /api/v1/avatar/chat
 * Accepts: { message, conversationId, botId }
 * Returns normal conversational AI response + structured avatar rendering metadata.
 */
exports.handleAvatarChat = async (req, res) => {
  const reqStartTime = Date.now();
  try {
    let { message, speech, audio, conversationId, botId: bodyBotId } = req.body;
    const botId = req.params.botId || bodyBotId;

    // Speech-to-Text conversion if user sent speech audio or speech input instead of text message
    let rawSpeechInput = speech || audio || req.file;
    if ((!message || typeof message !== "string" || !message.trim()) && rawSpeechInput) {
      message = await voiceService.convertSpeechToText(rawSpeechInput);
    }

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message prompt or speech audio input is required." });
    }

    let bot = null;
    if (botId) {
      bot = await Bot.findById(botId).catch(() => null);
    }

    if (!bot) {
      bot = await Bot.findOne({ botType: "AVATAR" }) || await Bot.findOne({});
    }

    if (!bot) {
      bot = await Bot.create({
        name: "General AI Avatar Assistant",
        description: "General Conversational AI Avatar Assistant",
        model: "best",
        botType: "AVATAR",
        responseMode: "HYBRID",
        avatar3DModel: "/models/viverse_avatar_model_210287.vrm",
        userId: req.user?.id || "65b000000000000000000001",
        ownerId: req.user?.id || "65b000000000000000000001"
      }).catch(() => null);
    }

    const effectiveBotId = bot?._id || "65b000000000000000000001";
    const effectiveUserId = req.user?.id || bot?.userId || "65b000000000000000000001";

    // Retrieve or create conversation in DEDICATED AvatarConversation collection
    let conversation;
    if (conversationId && conversationId !== "default") {
      conversation = await AvatarConversation.findOne({
        _id: conversationId
      }).catch(() => null);
    }

    if (!conversation) {
      conversation = await AvatarConversation.create({
        botId: effectiveBotId,
        userId: effectiveUserId,
        title: message.substring(0, 35) + "..."
      }).catch(() => ({
        _id: conversationId || `conv_${Date.now()}`,
        title: message.substring(0, 35) + "..."
      }));
    }

    // Fetch conversation history from DEDICATED AvatarMessage collection
    let history = [];
    if (conversation._id && typeof conversation._id === "object") {
      history = await AvatarMessage.find({ conversationId: conversation._id }).sort({ createdAt: 1 }).limit(10).catch(() => []);
    }

    // RAG Intent & Search
    const intent = detectBotIntent(message, bot.knowledgeSummary || {});
    const hasFilesCount = typeof effectiveBotId === "object" || (typeof effectiveBotId === "string" && !effectiveBotId.startsWith("default_"))
      ? await BotFile.countDocuments({ botId: effectiveBotId }).catch(() => 0)
      : 0;
    const hasUploadedFiles = hasFilesCount > 0;

    let ragResult = { isFound: true, chunks: [] };
    if (intent !== "GREETING" && hasUploadedFiles) {
      ragResult = await retrieveRelevantChunks(req.user?.id || bot.userId || "guest", effectiveBotId, message, 3, history, bot.knowledgeSummary);
    }

    const sourcesMeta = ragResult.isFound && ragResult.chunks.length > 0
      ? ragResult.chunks.map(c => ({ fileName: c.fileName, snippet: c.snippet.substring(0, 100) + "..." }))
      : [];

    // System Prompt Construction with Strict 2-Line Limit for Avatar Speech
    const rulesCacheKey = `bot:${effectiveBotId}:rules`;
    let cachedRulesObj = await getCache(rulesCacheKey);
    const effectiveRulesText = typeof cachedRulesObj === "object" ? (cachedRulesObj?.rulesText || "") : String(cachedRulesObj || "");
    const maxTwoLinesInstruction = "\n\nIMPORTANT MANDATE: Your response must be extremely concise and complete within a MAXIMUM of 2 sentences (or 2 short lines). Do NOT use bullet points, lists, or long explanations.";

    let systemPrompt;
    if (intent === "GREETING" && !hasUploadedFiles) {
      systemPrompt = buildGeneralSystemPrompt(bot.name, bot.description, "general", effectiveRulesText) + maxTwoLinesInstruction;
    } else {
      systemPrompt = buildRagSystemPrompt(bot.name, bot.description, ragResult.chunks, [], bot.knowledgeSummary, effectiveRulesText, "general") + maxTwoLinesInstruction;
    }

    // Prepare AI Gateway messages
    const ollamaMessages = [
      { role: "system", content: systemPrompt }
    ];

    history.forEach(m => {
      ollamaMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      });
    });

    ollamaMessages.push({ role: "user", content: message });

    const userPriority = await calculatePriority(req.user?.plan || "free");
    const gatewayResult = await aiGateway.generateStream({
      provider: "auto",
      model: bot.model || "best",
      messages: ollamaMessages,
      userPriority,
      jobId: `avatar_chat_${Date.now()}`
    });

    let responseText = (gatewayResult.text || "").trim();

    // Strict 2-line / 2-sentence post-processing truncation
    if (responseText) {
      // Remove markdown headings, bullet list markers, and bolding for clean avatar reading
      let cleanText = responseText
        .replace(/#+\s*/g, "")
        .replace(/^\s*[\*\-\+]\s+/gm, "")
        .replace(/\*\*/g, "")
        .replace(/\r?\n+/g, " ")
        .trim();

      // Extract up to 2 sentences
      const sentences = cleanText.match(/[^.!?]+[.!?]+/g) || [cleanText];
      if (sentences.length > 2) {
        responseText = sentences.slice(0, 2).join(" ").trim();
      } else if (sentences.length > 0) {
        responseText = sentences.join(" ").trim();
      } else {
        responseText = cleanText.substring(0, 160).trim();
      }
    }

    if (!responseText || !responseText.trim()) {
      responseText = "Hello! I am your AI assistant. How can I help you today?";
    }

    // Save messages in DEDICATED AvatarMessage collection
    if (conversation._id && typeof conversation._id === "object") {
      await AvatarMessage.create({
        conversationId: conversation._id,
        botId: effectiveBotId,
        userId: effectiveUserId,
        role: "user",
        content: message
      }).catch(err => console.warn("AvatarMessage user save warning:", err.message));

      await AvatarMessage.create({
        conversationId: conversation._id,
        botId: effectiveBotId,
        userId: effectiveUserId,
        role: "assistant",
        content: responseText,
        sources: sourcesMeta
      }).catch(err => console.warn("AvatarMessage assistant save warning:", err.message));
    }

    // Voice & Viseme generation
    const reqHost = `${req.protocol}://${req.get("host")}`;
    let speechData = null;
    try {
      speechData = await voiceService.generateSpeechAndVisemes(responseText, bot.voiceConfig || {}, reqHost);
    } catch (e) {
      console.warn("Avatar speech generation warning:", e.message);
    }

    // Build Avatar Metadata Object with Real-Time 3D Movement Values
    const avatarMetadata = {
      state: "speaking",
      expression: "friendly",
      animation: "talking",
      
      headMovement: true,
      eyeBlink: true,
      movements: {
        headRotation: { x: 0.02, y: 0.05, z: 0.0 },
        eyeBlinkRate: 3.5,
        breathingRate: 2.0,
        gesture: "nod"
      }
    };

    return res.json({
      success: true,
      response: responseText,
      message: responseText,
      conversationId: conversation._id,
      botId: effectiveBotId,
      avatar: avatarMetadata,
      speechData,
      avatarConfig: bot.avatarConfig || {},
      sources: sourcesMeta
    });
  } catch (err) {
    console.error("Avatar Chat Error:", err);
    return res.status(500).json({ error: "Failed to process avatar chat request.", details: err.message });
  }
};
