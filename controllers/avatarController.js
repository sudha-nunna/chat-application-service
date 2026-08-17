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
    let { message, speech, audio, conversationId, botId: bodyBotId } = req.body;
    const botId = req.params.botId || bodyBotId;

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

    if (hasValidAudio) {
      const sttInput = audioUploadedFile || rawSpeechBuffer || rawSpeechInput;
      console.log("🎤 [AVATAR CHAT STT] Transcribing audio recording into text...");
      const transcribedText = await voiceService.convertSpeechToText(sttInput);
      if (transcribedText && transcribedText.trim()) {
        console.log(`✅ [AVATAR CHAT STT SUCCESS] Transcribed Spoken Text: "${transcribedText.trim()}"`);
        textPrompt = transcribedText.trim();
      } else {
        console.warn("⚠️ [AVATAR CHAT STT NOTICE] Could not transcribe audio clip into text.");
      }
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

    // Memory Loading:
    // Retrieve last 6-10 messages from AvatarMessage and conversationSummary from AvatarConversation
    let historyMessages = [];
    if (activeConvId && typeof activeConvId === "object") {
      historyMessages = await AvatarMessage.find({ conversationId: activeConvId })
        .sort({ createdAt: -1 })
        .limit(10)
        .catch(() => []);
    }
    const history = historyMessages.reverse();
    const conversationSummary = activeConversation.conversationSummary || "";

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
      maxTokens: 60,
      jobId: `avatar_chat_${Date.now()}`
    });

    let responseText = (gatewayResult.text || "").trim();

    // Strict 2-line / 2-sentence post-processing truncation
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
        responseText = cleanText.substring(0, 160).trim();
      }
    }

    if (!responseText || !responseText.trim()) {
      responseText = "Hello! I am your AI assistant. How can I help you today?";
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
    const reqHost = `${req.protocol}://${req.get("host")}`;
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

      // Priority 1: User's explicitly selected active voice sample (userId AND isSelected: true)
      if (targetUserId) {
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
        const buf = getBufferData(activeAsset);
        if (buf && buf.length > 0) {
          cloneVoiceBuffer = buf;
          usedVoiceSampleId = String(activeAsset._id);
          usedVoiceSampleUrl = `${reqHost}/bots/media/${activeAsset._id}`;
          console.log(`🎤 [VOICE RESOLVED] Active Voice Sample ID: ${activeAsset._id} (${activeAsset.filename})`);
        }
      }

      // Generate cloned speech using cloneVoiceBuffer
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
