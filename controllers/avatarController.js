const mongoose = require("mongoose");
const Bot = require("../models/Bot");
const AvatarConversation = require("../models/AvatarConversation");
const AvatarMessage = require("../models/AvatarMessage");
const BotConversation = require("../models/BotConversation");
const BotMessage = require("../models/BotMessage");
const BotFile = require("../models/BotFile");
const aiGateway = require("../utils/aiGateway");
const { detectBotIntent, buildRagSystemPrompt, buildGeneralSystemPrompt, retrieveRelevantChunks, generateLLMSummary } = require("../utils/ragEngine");
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
    let { message, speech, audio, conversationId, botId: bodyBotId, name, voiceAgentName, agentName } = req.body;
    const botId = req.params.botId || bodyBotId;
    const customVoiceAgentName = (name || voiceAgentName || agentName || req.query?.name || req.query?.voiceAgentName || "").trim();

    let textPrompt = message || req.body?.messageText || req.body?.prompt || req.body?.text || req.body?.userMessage || req.body?.query || "";

    const avatarFilesArray = Array.isArray(req.files) ? req.files : [];
    const avatarFilesMap = !Array.isArray(req.files) ? (req.files || {}) : {};
    let audioUploadedFile = avatarFilesMap.audio?.[0] || avatarFilesMap.audioFile?.[0] || (avatarFilesArray[0] && avatarFilesArray[0].buffer ? avatarFilesArray[0] : null) || req.file;

    if (audioUploadedFile && (!audioUploadedFile.buffer || audioUploadedFile.buffer.length === 0)) {
      audioUploadedFile = null;
    }

    let rawSpeechInput = speech || audio || req.body?.audioFile || audioUploadedFile;
    let rawSpeechBuffer = null;

    if (audioUploadedFile && audioUploadedFile.buffer && audioUploadedFile.buffer.length > 0) {
      rawSpeechBuffer = audioUploadedFile.buffer;
    } else if (typeof rawSpeechInput === "string" && rawSpeechInput.trim().length > 100) {
      const trimmed = rawSpeechInput.trim();
      if (trimmed.startsWith("data:audio")) {
        const base64Content = trimmed.split(",")[1] || "";
        if (base64Content) {
          rawSpeechBuffer = Buffer.from(base64Content, "base64");
        }
      } else if (!trimmed.startsWith("http") && /^[A-Za-z0-9+/=\s\r\n]+$/.test(trimmed.substring(0, 100))) {
        rawSpeechBuffer = Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
      }
    }

    const hasValidAudio = (rawSpeechBuffer && rawSpeechBuffer.length > 0) || (typeof rawSpeechInput === "string" && rawSpeechInput.length > 100 && !rawSpeechInput.startsWith("http"));

    console.log(`\n==================================================`);
    console.log(`🤖 [AVATAR CHAT INCOMING PAYLOAD] User ID: ${req.user?.id || "Guest/Anonymous"} | Bot ID: ${botId || "Default"}`);
    console.log(`📋 Content-Type: ${req.headers["content-type"] || "unknown"}`);
    console.log(`📦 Body Parameters:`, JSON.stringify(req.body || {}));
    if (avatarFilesArray.length > 0) {
      console.log(`📁 Uploaded Files (${avatarFilesArray.length}):`, avatarFilesArray.map(f => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size
      })));
    } else {
      console.log(`📁 Uploaded Files: None (JSON / Text payload)`);
    }
    console.log(`📍 Request Type: ${hasValidAudio ? "🎤 AUDIO (VOICE RECORDING)" : "💬 TEXT MESSAGE"}`);
    if (hasValidAudio) {
      console.log(`🔊 Attached Audio Buffer: ${rawSpeechBuffer?.length || 0} bytes | MIME: ${audioUploadedFile?.mimetype || "audio/wav"}`);
    } else {
      console.log(`💬 Input Text Message: "${textPrompt}"`);
    }

    let explicitTextMessage = (message || req.body?.messageText || req.body?.prompt || req.body?.text || req.body?.userMessage || req.body?.query || "").trim();

    // Senior Developer STT Precedence:
    // If a valid audio recording is uploaded, ALWAYS process STT first!
    if (hasValidAudio) {
      const sttInput = audioUploadedFile || rawSpeechBuffer || rawSpeechInput;
      console.log("🎤 [AVATAR CHAT STT] Transcribing microphone audio recording into text...");
      try {
        const transcribedText = await voiceService.convertSpeechToText(sttInput);
        if (transcribedText && transcribedText.trim()) {
          console.log(`✅ [AVATAR CHAT STT SUCCESS] Transcribed Spoken Text: "${transcribedText.trim()}"`);
          textPrompt = transcribedText.trim();
        } else if (explicitTextMessage && explicitTextMessage !== "tell me one joke") {
          textPrompt = explicitTextMessage;
        }
      } catch (sttErr) {
        console.warn("⚠️ [AVATAR CHAT STT ERROR]", sttErr.message);
        if (explicitTextMessage) textPrompt = explicitTextMessage;
      }
    } else if (explicitTextMessage) {
      textPrompt = explicitTextMessage;
      console.log(`💬 Using Explicit User Text Prompt: "${textPrompt}"`);
    }

    if (!textPrompt || typeof textPrompt !== "string" || !textPrompt.trim()) {
      textPrompt = "Hello! Please assist me.";
    }
    message = textPrompt;
    console.log(`💬 Final Prompt Sent To LLM: "${message}"`);

    let bot = null;
    if (botId) {
      bot = await Bot.findById(botId).catch(() => null);
    }

    if (!bot) {
      bot = await Bot.findOne({ botType: "AVATAR" }) || await Bot.findOne({});
    }

    if (!bot) {
      bot = await Bot.create({
        name: customVoiceAgentName || "General AI Avatar Assistant",
        description: "General Conversational AI Avatar Assistant",
        model: "best",
        botType: "AVATAR",
        responseMode: "HYBRID",
        avatar3DModel: "/models/viverse_avatar_model_210287.vrm",
        userId: req.user?.id || "65b000000000000000000001",
        ownerId: req.user?.id || "65b000000000000000000001"
      }).catch(() => null);
    } else if (customVoiceAgentName && bot.name !== customVoiceAgentName) {
      console.log(`🤖 [AVATAR CHAT] Voice Agent Name updated from "${bot.name}" to "${customVoiceAgentName}" (BotId: ${bot._id})`);
      bot.name = customVoiceAgentName;
      await bot.save().catch((err) => console.warn("Failed to update voice agent name:", err.message));
    }

    const effectiveBotId = bot?._id || "65b000000000000000000001";
    const effectiveUserId = req.user?.id || bot?.userId || "65b000000000000000000001";

    const User = require("../models/User");
    const currentUser = effectiveUserId ? await User.findById(effectiveUserId).catch(() => null) : null;
    const effectiveBotName = customVoiceAgentName || currentUser?.botName || bot?.name || "AI Assistant";

    if (currentUser?.botName && bot && bot.name !== currentUser.botName && !customVoiceAgentName) {
      bot.name = currentUser.botName;
      await bot.save().catch(() => {});
    }

    // Conversation Resolution:
    // Reuse existing conversation if conversationId exists, or create ONE new AvatarConversation
    let activeConversation = null;
    if (conversationId && conversationId !== "default" && mongoose.Types.ObjectId.isValid(conversationId)) {
      activeConversation = await AvatarConversation.findById(conversationId).catch(() => null);
    }

    if (!activeConversation) {
      activeConversation = await AvatarConversation.create({
        botId: effectiveBotId,
        userId: effectiveUserId,
        title: message.trim().substring(0, 35) || "New Avatar Conversation"
      }).catch(() => null);
    }

    if (!activeConversation) {
      activeConversation = {
        _id: conversationId || `conv_${Date.now()}`,
        botId: effectiveBotId,
        userId: effectiveUserId,
        title: message.trim().substring(0, 35) || "New Avatar Conversation"
      };
    }

    const activeConvId = activeConversation._id;

    // Parallelized Memory Loading, RAG Count, Rules Cache, and Redis Active Voice Cache
    const rulesCacheKey = `bot:${effectiveBotId}:rules`;
    const userVoiceCacheKey = `user:${effectiveUserId}:active_voice_asset_id`;

    const [historyMessagesRaw, hasFilesCount, cachedRulesObj, cachedVoiceAssetId] = await Promise.all([
      (activeConvId && typeof activeConvId === "object")
        ? AvatarMessage.find({ conversationId: activeConvId }).sort({ createdAt: -1 }).limit(10).catch(() => [])
        : Promise.resolve([]),
      (typeof effectiveBotId === "object" || (typeof effectiveBotId === "string" && !effectiveBotId.startsWith("default_")))
        ? BotFile.countDocuments({ botId: effectiveBotId }).catch(() => 0)
        : Promise.resolve(0),
      getCache(rulesCacheKey),
      getCache(userVoiceCacheKey)
    ]);

    const history = (historyMessagesRaw || []).reverse();
    const conversationSummary = activeConversation.conversationSummary || "";
    const hasUploadedFiles = hasFilesCount > 0;

    // RAG Intent & Search
    const intent = detectBotIntent(message, bot.knowledgeSummary || {});
    let ragResult = { isFound: true, chunks: [] };
    if (intent !== "GREETING" && hasUploadedFiles) {
      ragResult = await retrieveRelevantChunks(req.user?.id || bot.userId || "guest", effectiveBotId, message, 3, history, bot.knowledgeSummary);
    }

    const sourcesMeta = ragResult.isFound && ragResult.chunks.length > 0
      ? ragResult.chunks.map(c => ({ fileName: c.fileName, snippet: c.snippet.substring(0, 100) + "..." }))
      : [];

    let effectiveRulesText = typeof cachedRulesObj === "object" ? (cachedRulesObj?.rulesText || "") : String(cachedRulesObj || "");
    if (effectiveRulesText.includes("Hello! I am your AI assistant") || effectiveRulesText.includes("How can I help you today")) {
      effectiveRulesText = "";
    }

    let baseSystemPrompt = (req.body?.systemPrompt && typeof req.body.systemPrompt === "string" && req.body.systemPrompt.trim())
      ? req.body.systemPrompt.trim()
      : `You are an intelligent, friendly AI assistant. Your name is "${effectiveBotName}".`;

    const systemPrompt = `${baseSystemPrompt}

IDENTITY & NAME MANDATE:
- Your name is "${effectiveBotName}".
- When asked "what is your name?", "who are you?", "tell me your name", or introduce yourself, you MUST state your name clearly as "${effectiveBotName}" (for example: "I am ${effectiveBotName}, how can I help you today?").
- Always introduce and refer to yourself as "${effectiveBotName}". NEVER claim to be ChatGPT, OpenAI, Gemini, or Google.

STRICT FORMAT MANDATE:
Answer the user's prompt or question directly in 1 to 2 short, concise sentences suitable for spoken speech (maximum 30 words total). Do NOT write long paragraphs.`;

    // Build prompt in exact order: System Prompt -> Conversation Summary -> Recent Messages -> Current User Message
    const ollamaMessages = [
      { role: "system", content: systemPrompt }
    ];

    if (conversationSummary && conversationSummary.trim()) {
      ollamaMessages.push({
        role: "system",
        content: `Conversation Summary:\n${conversationSummary}`
      });
    }

    const filteredHistory = history.filter(m => m.content && !m.content.includes("Hello! I am your AI assistant"));

    filteredHistory.slice(-4).forEach(m => {
      ollamaMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      });
    });

    ollamaMessages.push({ role: "user", content: message });

    const isDetailedQuery = /\b(detail|detailed|explain\s+in\s+detail|code|steps|step\s+by\s+step|essay|long|list|write\s+a|how\s+to)\b/i.test(message);
    const requestedMaxTokens = Number(req.body?.maxTokens || req.body?.max_tokens);
    const effectiveMaxTokens = requestedMaxTokens > 0
      ? requestedMaxTokens
      : (isDetailedQuery ? 1000 : 300);

    const userPriority = await calculatePriority(req.user?.plan || "free");
    console.log("💬 [AVATAR CHAT PROMPT SENT TO LLM]:", JSON.stringify(ollamaMessages, null, 2));

    const gatewayResult = await aiGateway.generateStream({
      provider: "auto",
      model: "best",
      messages: ollamaMessages,
      userPriority,
      maxTokens: effectiveMaxTokens,
      jobId: `avatar_chat_${Date.now()}`
    });

    console.log("🤖 [AVATAR CHAT RAW GATEWAY RESPONSE]:", JSON.stringify(gatewayResult, null, 2));

    let responseText = (gatewayResult?.text || "").trim();

    if (!responseText || !responseText.trim()) {
      console.warn("⚠️ [AVATAR CHAT] Cluster gateway returned empty text. Calling direct Cloud Gemini fallback...");
      try {
        const cloudRes = await aiGateway._streamCloudGemini({ model: "gemini-2.5-flash", messages: ollamaMessages });
        if (cloudRes && cloudRes.text) {
          responseText = cloudRes.text.trim();
          console.log(`✅ [AVATAR CHAT CLOUD FALLBACK SUCCESS] Generated Response: "${responseText}"`);
        }
      } catch (fErr) {
        console.warn("⚠️ [AVATAR CHAT CLOUD FALLBACK NOTICE]", fErr.message);
      }
    }

    // Enforce strict 1 to 2 sentence limit for avatar speech (as requested)
    if (responseText) {
      let cleanText = responseText
        .replace(/#+\s*/g, "")
        .replace(/^\s*[\*\-\+]\s+/gm, "")
        .replace(/\*\*/g, "")
        .replace(/\r?\n+/g, " ")
        .trim();

      const sentences = cleanText.match(/[^.!?]+[.!?]+/g) || [cleanText];
      if (sentences.length > 2) {
        responseText = sentences.slice(0, 2).join(" ").trim();
      } else if (sentences.length > 0) {
        responseText = sentences.join(" ").trim();
      } else {
        responseText = cleanText.substring(0, 200).trim();
      }
    }

    if (!responseText || !responseText.trim()) {
      console.warn("⚠️ [AVATAR CHAT] All LLM nodes failed to generate text response.");
      return res.status(503).json({
        success: false,
        error: "All LLM server nodes are currently busy or rate-limited. Please try again in a few seconds."
      });
    }

    // Save messages in DEDICATED AvatarMessage collection using activeConvId
    if (activeConvId && typeof activeConvId === "object") {
      await AvatarMessage.create({
        conversationId: activeConvId,
        botId: effectiveBotId,
        userId: effectiveUserId,
        role: "user",
        content: message
      }).catch(err => console.warn("AvatarMessage user save warning:", err.message));

      await AvatarMessage.create({
        conversationId: activeConvId,
        botId: effectiveBotId,
        userId: effectiveUserId,
        role: "assistant",
        content: responseText,
        sources: sourcesMeta
      }).catch(err => console.warn("AvatarMessage assistant save warning:", err.message));

      // Async background LLM summarization trigger
      const totalMsgCount = await AvatarMessage.countDocuments({ conversationId: activeConvId }).catch(() => 0);
      if (totalMsgCount >= 16 && totalMsgCount % 8 === 0) {
        generateLLMSummary(history, conversationSummary)
          .then((newSummary) => {
            if (newSummary) {
              AvatarConversation.findByIdAndUpdate(activeConvId, { conversationSummary: newSummary }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }

    // Voice & Viseme generation (Production Voice Profile Architecture)
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    const reqHost = `${proto}://${req.get("host")}`.replace(/\/$/, "");
    let speechData = null;
    let usedVoiceSampleId = "";
    let usedVoiceSampleUrl = "";

    try {
      const User = require("../models/User");
      const MediaAsset = require("../models/MediaAsset");

      const getBufferData = (asset) => {
        if (!asset || !asset.data) return null;
        if (Buffer.isBuffer(asset.data)) return asset.data;
        if (asset.data.buffer) return Buffer.from(asset.data.buffer);
        if (asset.data.data) return Buffer.from(asset.data.data);
        return Buffer.from(asset.data);
      };

      // 1. Resolve Target Voice Sample Buffer for Voice Cloning:
      let cloneVoiceBuffer = null;
      let targetUserId = req.user?.id || req.body?.userId;

      if (!targetUserId && req.body?.email) {
        const u = await User.findOne({ email: req.body.email }).catch(() => null);
        if (u) targetUserId = u._id;
      }

      let activeAsset = null;

      // Priority 0: Fast Redis Cache lookup (0ms DB overhead)
      if (cachedVoiceAssetId && mongoose.Types.ObjectId.isValid(cachedVoiceAssetId)) {
        activeAsset = await MediaAsset.findById(cachedVoiceAssetId).catch(() => null);
      }

      // Priority 1: User's explicitly selected active voice sample (userId AND isSelected: true)
      if (!activeAsset && targetUserId) {
        activeAsset = await MediaAsset.findOne({ userId: targetUserId, type: "VOICE_SAMPLE", isSelected: true }).sort({ updatedAt: -1 }).catch(() => null);
        if (!activeAsset) {
          const userDoc = await User.findById(targetUserId).catch(() => null);
          if (userDoc?.voiceSampleId) {
            activeAsset = await MediaAsset.findById(userDoc.voiceSampleId).catch(() => null);
          }
        }
      }

      // Priority 2: Any MediaAsset marked with isSelected: true in MongoDB
      if (!activeAsset) {
        activeAsset = await MediaAsset.findOne({ type: "VOICE_SAMPLE", isSelected: true }).sort({ updatedAt: -1 }).catch(() => null);
      }

      // Priority 3: Any User in DB with a linked voiceSampleId
      if (!activeAsset) {
        const userWithVoice = await User.findOne({ voiceSampleId: { $ne: null } }).sort({ updatedAt: -1 }).catch(() => null);
        if (userWithVoice?.voiceSampleId) {
          activeAsset = await MediaAsset.findById(userWithVoice.voiceSampleId).catch(() => null);
        }
      }

      // Priority 4: Explicit voiceSampleId passed in body
      if (!activeAsset && req.body?.voiceSampleId) {
        activeAsset = await MediaAsset.findById(req.body.voiceSampleId).catch(() => null);
      }

      // Priority 5: Bot's custom voice sample
      if (!activeAsset && bot?.voiceSampleId) {
        activeAsset = await MediaAsset.findById(bot.voiceSampleId).catch(() => null);
      }

      // Priority 6: Latest VOICE_SAMPLE uploaded to MongoDB
      if (!activeAsset) {
        activeAsset = await MediaAsset.findOne({ type: "VOICE_SAMPLE" }).sort({ createdAt: -1 }).catch(() => null);
      }

      if (activeAsset) {
        setCache(userVoiceCacheKey, String(activeAsset._id), 600).catch(() => {});
        const buf = getBufferData(activeAsset);
        if (buf && buf.length > 0) {
          cloneVoiceBuffer = buf;
          usedVoiceSampleId = String(activeAsset._id);
          usedVoiceSampleUrl = `${reqHost}/bots/media/${activeAsset._id}`;
          console.log(`🎤 [VOICE RESOLVED] Active Voice Sample ID: ${activeAsset._id} (${activeAsset.filename})`);
        }
      }

      // High-Speed Redis Voice Cache Lookup (0ms overhead if pre-synthesized)
      const crypto = require("crypto");
      const textVoiceHash = crypto.createHash("md5").update(`${responseText}_${usedVoiceSampleId || "default"}`).digest("hex");
      const ttsRedisKey = `avatar:tts:${textVoiceHash}`;

      const cachedTtsData = await getCache(ttsRedisKey).catch(() => null);

      if (cachedTtsData && cachedTtsData.audioUrl) {
        console.log(`⚡ [REDIS TTS HIT] Retrieved pre-synthesized audio URL & visemes in 0ms!`);
        speechData = cachedTtsData;
      } else {
        if (cloneVoiceBuffer && cloneVoiceBuffer.length > 0) {
          const engineOpt = req.body.voiceEngine || req.body.engine || bot?.voiceEngine || bot?.voiceConfig?.voiceEngine;
          speechData = await voiceService.generateClonedSpeechAndVisemes(
            responseText,
            cloneVoiceBuffer,
            reqHost,
            { ...(bot.voiceConfig || {}), engine: engineOpt }
          );
        } else {
          speechData = await voiceService.generateSpeechAndVisemes(responseText, bot.voiceConfig || {}, reqHost);
        }

        if (speechData && speechData.audioUrl) {
          setCache(ttsRedisKey, speechData, 3600).catch(() => {});
        }
      }
    } catch (e) {
      console.warn("Avatar speech generation notice:", e.message);
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

    const durationMs = Date.now() - reqStartTime;
    console.log(`🚀 [AVATAR CHAT RESPONSE GENERATED] (${durationMs}ms)`);
    console.log(`💬 Generated AI Response: "${responseText}"`);
    console.log(`🔊 Spoken Audio URL: ${speechData?.audioUrl || "None"}`);
    console.log(`🎙️ Voice Profile Applied: ${usedVoiceSampleId ? `ID: ${usedVoiceSampleId}` : "Default TTS Tone"}`);
    console.log(`==================================================\n`);

    return res.json({
      success: true,
      botName: bot?.name || customVoiceAgentName || "General AI Avatar Assistant",
      name: bot?.name || customVoiceAgentName || "General AI Avatar Assistant",
      voiceAgentName: bot?.name || customVoiceAgentName || "General AI Avatar Assistant",
      conversationId: activeConvId,
      response: responseText,
      message: responseText,
      audioUrl: speechData?.audioUrl || "",
      activeVoiceSampleId: usedVoiceSampleId || "",
      activeVoiceSampleUrl: usedVoiceSampleUrl || "",
      visemes: speechData?.visemes || [],
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

/**
 * Get all avatar conversation history
 * Endpoint: GET /bots/avatar/conversations or GET /api/v1/avatar/conversations
 */
exports.getAvatarConversations = async (req, res) => {
  try {
    const userId = req.user?.id || req.query.userId;
    const filter = userId ? { userId } : {};
    const conversations = await AvatarConversation.find(filter).sort({ updatedAt: -1 }).limit(50);
    return res.json({ success: true, conversations });
  } catch (err) {
    console.error("Get Avatar Conversations error:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch avatar conversations." });
  }
};

/**
 * Create a new avatar conversation thread ("New Chat")
 * Endpoint: POST /bots/avatar/conversations or POST /api/v1/avatar/conversations
 */
exports.createAvatarConversation = async (req, res) => {
  try {
    const { title, name, botId } = req.body;
    const userId = req.user?.id || "65b000000000000000000001";

    if (name && typeof name === "string" && name.trim()) {
      let bot = await Bot.findOne({ botType: "AVATAR" }) || await Bot.findOne({});
      if (bot) {
        bot.name = name.trim();
        await bot.save().catch(() => {});
      }
    }

    const conversation = await AvatarConversation.create({
      botId: botId || undefined,
      userId: userId,
      title: title || name || "New Voice Agent Chat"
    });

    return res.status(201).json({ success: true, conversation });
  } catch (err) {
    console.error("Create Avatar Conversation error:", err);
    return res.status(500).json({ success: false, error: "Failed to create avatar conversation." });
  }
};

/**
 * Get all messages for a specific avatar conversation thread
 * Endpoint: GET /bots/avatar/conversations/:conversationId/messages or GET /api/v1/avatar/conversations/:conversationId/messages
 */
exports.getAvatarMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, error: "Invalid conversation ID format." });
    }
    const messages = await AvatarMessage.find({ conversationId }).sort({ createdAt: 1 });
    return res.json({ success: true, messages });
  } catch (err) {
    console.error("Get Avatar Messages error:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch avatar messages." });
  }
};

/**
 * Delete an avatar conversation thread and all its messages ("Delete History")
 * Endpoint: DELETE /bots/avatar/conversations/:conversationId or DELETE /api/v1/avatar/conversations/:conversationId
 */
exports.deleteAvatarConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({ success: false, error: "Invalid conversation ID format." });
    }
    const deletedConv = await AvatarConversation.findByIdAndDelete(conversationId);
    if (!deletedConv) {
      return res.status(404).json({ success: false, error: "Avatar conversation not found." });
    }
    await AvatarMessage.deleteMany({ conversationId });
    return res.json({ success: true, message: "Avatar conversation history deleted successfully.", conversationId });
  } catch (err) {
    console.error("Delete Avatar Conversation error:", err);
    return res.status(500).json({ success: false, error: "Failed to delete avatar conversation history." });
  }
};
