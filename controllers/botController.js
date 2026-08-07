const mongoose = require("mongoose");
const { performance } = require("perf_hooks");
const Bot = require("../models/Bot");
const BotFile = require("../models/BotFile");
const BotChunk = require("../models/BotChunk");
const BotEmbedding = require("../models/BotEmbeddings");
const BotApi = require("../models/BotApi");
const BotConversation = require("../models/BotConversation");
const BotMessage = require("../models/BotMessage");
const BotContact = require("../models/BotContact");
const Summary = require("../models/Summary");
const memoryService = require("../services/memoryService");
const { getCache, setCache, delCache } = require("../utils/redisClient");
const { encrypt, decrypt } = require("../utils/crypto");
const {
  chunkText,
  generateEmbeddingVector,
  generateEmbeddingVectorAsync,
  generateLLMSummary,
  extractKnowledgeMetadataFromText,
  buildKnowledgeOverviewResponse,
  retrieveRelevantChunks,
  buildRagSystemPrompt,
  detectBotIntent
} = require("../utils/ragEngine");

// Helper for SSE streaming
async function streamTextInChunks(res, text, delayMs = 15) {
  const tokens = text.match(/\s+|\S+/g) || [text];
  for (const token of tokens) {
    console.log(`📡 [SSE OUT Chunk (Helper)]`, JSON.stringify({ text: token }));
    res.write(`event: chunk\ndata: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// -----------------------------------------------------------------------------
// 1. BOT CRUD CONTROLLERS
// -----------------------------------------------------------------------------

exports.createBot = async (req, res) => {
  try {
    const { name, description, model, botMode, allowedDomains, systemPrompt, rulesText, initialApis, stagedFiles } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Bot name is required." });
    }

    const uploadedFiles = Array.isArray(stagedFiles) ? stagedFiles : [];
    if (uploadedFiles.length === 0 && (!rulesText || !rulesText.trim())) {
      return res.status(400).json({ error: "Please upload at least one knowledge/rules file or specify rules before creating the bot." });
    }

    // Validate Rule Limits if rulesText is provided directly
    if (rulesText && typeof rulesText === "string" && rulesText.trim()) {
      const validation = validateRulesLimits(rulesText);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    // Determine botMode: small, medium, or large
    const effectiveBotMode = (botMode || model || "small").toLowerCase();
    const finalBotMode = ["small", "medium", "large"].includes(effectiveBotMode) ? effectiveBotMode : "small";
    const finalModel = (model && !["small", "medium", "large"].includes(model.toLowerCase())) ? model : "gpt-4o";
    const domainsList = Array.isArray(allowedDomains) ? allowedDomains.map(d => String(d).trim().toLowerCase()).filter(Boolean) : [];

    const rawRulesText = (rulesText && typeof rulesText === "string") ? rulesText.trim() : "";
    const rulesLines = rawRulesText.split(/\r?\n/).filter(l => l.trim().length > 0);
    const initialRulesObj = {
      manualRulesText: rawRulesText,
      rulesText: rawRulesText,
      rulesCount: rulesLines.length,
      wantsScheduleCard: /\b(schedule|call|agent|human|appointment|meeting|card|contact|escalat)\b/i.test(rawRulesText),
      rulesList: rulesLines,
      sourceFiles: []
    };

    const bot = await Bot.create({
      ownerId: req.user.id,
      userId: req.user.id,
      name: name.trim(),
      description: description ? description.trim() : "",
      model: finalModel,
      botMode: finalBotMode,
      allowedDomains: domainsList,
      systemPrompt: systemPrompt || "You are a specialized AI assistant.",
      rulesConfig: initialRulesObj
    });

    // Sync rules object to Redis if provided directly
    if (bot.rulesConfig?.rulesText) {
      const { setCache } = require("../utils/redisClient");
      await setCache(`bot:${bot._id}:rules`, initialRulesObj, 3600);
    }

    // Create initial APIs if provided
    if (initialApis && Array.isArray(initialApis)) {
      for (const apiItem of initialApis) {
        if (apiItem.name && apiItem.url) {
          await BotApi.create({
            botId: bot._id,
            ownerId: req.user.id,
            userId: req.user.id,
            name: apiItem.name.trim(),
            url: apiItem.url.trim(),
            method: apiItem.method || "GET",
            authType: apiItem.authType || "none",
            encryptedApiKey: apiItem.apiKey ? encrypt(apiItem.apiKey) : null
          });
        }
      }
    }

    return res.status(201).json(bot);
  } catch (err) {
    console.error("Create Bot error:", err);
    return res.status(500).json({ error: "Failed to create AI Bot." });
  }
};

exports.getBots = async (req, res) => {
  try {
    const bots = await Bot.find({
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    }).sort({ createdAt: -1 });

    const enrichedBots = await Promise.all(
      bots.map(async (b) => {
        const fileCount = await BotFile.countDocuments({ botId: b._id });
        const apiCount = await BotApi.countDocuments({ botId: b._id });
        return {
          ...b.toObject(),
          fileCount,
          apiCount
        };
      })
    );

    return res.json(enrichedBots);
  } catch (err) {
    console.error("Get Bots error:", err);
    return res.status(500).json({ error: "Failed to fetch bots." });
  }
};

exports.getBotById = async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const fileCount = await BotFile.countDocuments({ botId: bot._id });
    const apiCount = await BotApi.countDocuments({ botId: bot._id });

    return res.json({
      ...bot.toObject(),
      fileCount,
      apiCount
    });
  } catch (err) {
    console.error("Get Bot By ID error:", err);
    return res.status(500).json({ error: "Failed to fetch bot details." });
  }
};

exports.updateBot = async (req, res) => {
  try {
    const { botId } = req.params;
    const { name, model } = req.body;

    const updateData = {};
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Bot name is required and cannot be empty." });
      }
      updateData.name = name.trim();
    }

    if (model !== undefined) {
      if (typeof model !== "string" || !model.trim()) {
        return res.status(400).json({ error: "Model is required and cannot be empty." });
      }
      updateData.model = model.trim();
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "Please provide bot name or model to update." });
    }

    const bot = await Bot.findOneAndUpdate(
      { _id: botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] },
      updateData,
      { new: true }
    );

    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const { delCache } = require("../utils/redisClient");
    await delCache(`bot_cfg_${botId}_${req.user.id}`);

    return res.json(bot);
  } catch (err) {
    console.error("Update Bot error:", err);
    return res.status(500).json({ error: "Failed to update bot." });
  }
};

exports.deleteBot = async (req, res) => {
  try {
    const { botId } = req.params;
    const rawUserId = req.user?.id || req.user?._id || req.user?.userId;
    const userIdStr = rawUserId ? rawUserId.toString() : null;

    const bot = await Bot.findById(botId);

    if (bot) {
      const isOwner = !userIdStr ||
        (bot.userId && bot.userId.toString() === userIdStr) ||
        (bot.ownerId && bot.ownerId.toString() === userIdStr);

      if (!isOwner) {
        return res.status(403).json({ success: false, message: "Unauthorized to delete this bot." });
      }

      await Bot.findByIdAndDelete(botId);
    }

    const convs = await BotConversation.find({ botId }).select("_id");
    const convIds = convs.map(c => c._id);

    // Cascade delete associated resources
    await Promise.all([
      BotFile.deleteMany({ botId }),
      BotChunk.deleteMany({ botId }),
      BotEmbedding.deleteMany({ botId }),
      BotApi.deleteMany({ botId }),
      BotConversation.deleteMany({ botId }),
      BotMessage.deleteMany({ botId }),
      BotContact.deleteMany({ botId }),
      Summary.deleteMany({ chatId: { $in: convIds } })
    ]);

    await delCache(`bot:${botId}:rules`).catch(() => {});

    return res.json({ success: true, message: "Bot and all associated multi-tenant knowledge base data deleted successfully." });
  } catch (err) {
    console.error("Delete Bot error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete bot.", error: err.message });
  }
};

// -----------------------------------------------------------------------------
// 2. KNOWLEDGE UPLOAD & RAG CHUNKING CONTROLLERS
// -----------------------------------------------------------------------------

function validateRulesLimits(rulesText) {
  if (!rulesText || typeof rulesText !== "string") {
    return { valid: true, ruleCount: 0, charCount: 0 };
  }
  const trimmed = rulesText.trim();
  const ruleLines = trimmed.split(/\r?\n/).filter(line => line.trim().length > 0);
  return { valid: true, ruleCount: ruleLines.length, charCount: trimmed.length };
}

/**
 * Intelligently parse raw text into clean, cohesive Rule items.
 * Bundles section titles (e.g. "1. RESPONSE LENGTH") with their bullet points
 * and strips out decorative divider lines (e.g. ===, ---).
 */
function parseStructuredRules(rawText) {
  if (!rawText || typeof rawText !== "string") return [];

  // Split by newlines and clean lines
  const rawLines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => {
    if (!l) return false;
    if (/^[=\-*#\s]{3,}$/.test(l)) return false; // Ignore decorative divider lines like ===, ---
    if (/^={3,}.*=*/.test(l) || /=*={3,}$/.test(l)) return false; // Ignore header bars like === CODEGENE AI ===
    return true;
  });

  const ruleItems = [];

  for (const line of rawLines) {
    // If line has internal bullet points separated by bullet characters like •, split them as well
    if (line.includes("•")) {
      const subItems = line.split("•").map(s => s.trim()).filter(Boolean);
      subItems.forEach(item => {
        const clean = item.replace(/^[\d+\.\-\*•\s]+/, "").trim();
        if (clean && clean.length > 2) ruleItems.push(clean);
      });
    } else {
      const clean = line.replace(/^[\d+\.\-\*•\s]+/, "").trim();
      if (clean && clean.length > 2) {
        ruleItems.push(clean);
      }
    }
  }

  return Array.from(new Set(ruleItems));
}

async function syncBotRulesText(botId) {
  try {
    const { setCache, delCache } = require("../utils/redisClient");
    const bot = await Bot.findById(botId).select("rulesConfig");
    const rulesFiles = await BotFile.find({ botId, fileCategory: "rules" });

    const fileRulesTexts = rulesFiles
      .map(f => f.parsedText || f.originalContent || "")
      .filter(Boolean);

    const sourceFiles = rulesFiles.map(f => f.fileName);

    const allTextParts = [];
    const manualRulesText = bot?.rulesConfig?.manualRulesText || "";
    if (manualRulesText && manualRulesText.trim()) {
      allTextParts.push(manualRulesText.trim());
    }
    allTextParts.push(...fileRulesTexts);

    const fullRawText = allTextParts.join("\n");
    const rulesLines = parseStructuredRules(fullRawText);
    const combinedRulesText = rulesLines.join("\n");

    const rulesObj = {
      manualRulesText,
      rulesText: combinedRulesText,
      rulesCount: rulesLines.length,
      wantsScheduleCard: /\b(schedule|call|agent|human|appointment|meeting|card|contact|escalat|live_agent)\b/i.test(combinedRulesText),
      rulesList: rulesLines,
      sourceFiles
    };

    await Bot.findByIdAndUpdate(botId, {
      rulesConfig: rulesObj
    });

    const rulesKey = `bot:${botId}:rules`;
    if (combinedRulesText.trim()) {
      await setCache(rulesKey, rulesObj, 3600); // 1 hour TTL
    } else {
      await delCache(rulesKey);
    }

    return combinedRulesText;
  } catch (err) {
    console.error("syncBotRulesText Error:", err);
    return "";
  }
}

/**
 * Controller to update itemized rules list (add, edit, delete rule items directly)
 * Endpoint: PUT /bots/:botId/rules
 */
exports.updateBotRules = async (req, res) => {
  try {
    const { botId } = req.params;
    const { rulesList, manualRulesText } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    let finalRulesList = [];

    if (Array.isArray(rulesList)) {
      finalRulesList = rulesList.map(r => String(r).trim()).filter(Boolean);
    } else if (typeof manualRulesText === "string") {
      finalRulesList = parseStructuredRules(manualRulesText);
    } else {
      return res.status(400).json({ error: "Please provide valid rulesList array or manualRulesText string." });
    }

    const combinedRulesText = Array.from(new Set(finalRulesList)).join("\n");
    const validation = validateRulesLimits(combinedRulesText);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const rulesFiles = await BotFile.find({ botId, fileCategory: "rules" });
    const sourceFiles = rulesFiles.map(f => f.fileName);

    const rulesObj = {
      manualRulesText: typeof manualRulesText === "string" ? manualRulesText.trim() : combinedRulesText,
      rulesText: combinedRulesText,
      rulesCount: finalRulesList.length,
      wantsScheduleCard: /\b(schedule|call|agent|human|appointment|meeting|card|contact|escalat)\b/i.test(combinedRulesText),
      rulesList: finalRulesList,
      sourceFiles
    };

    bot.rulesConfig = rulesObj;
    await bot.save();

    const { setCache, delCache } = require("../utils/redisClient");
    const rulesKey = `bot:${botId}:rules`;
    if (combinedRulesText.trim()) {
      await setCache(rulesKey, rulesObj, 3600);
    } else {
      await delCache(rulesKey);
    }
    await delCache(`bot_cfg_${botId}_${req.user.id}`);

    return res.json({
      success: true,
      message: "Bot rules updated successfully.",
      rulesConfig: rulesObj
    });
  } catch (err) {
    console.error("Update Bot Rules Error:", err);
    return res.status(500).json({ error: "Failed to update bot rules." });
  }
};

exports.uploadBotFile = async (req, res) => {
  try {
    const { botId } = req.params;
    const { fileName, fileType, fileCategory, fileContentBase64, rawText } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const cleanName = fileName || `file_${Date.now()}.${fileType || "txt"}`;
    const detectedType = (fileType || cleanName.split(".").pop() || "txt").toLowerCase();
    const category = (fileCategory || "knowledge").toLowerCase() === "rules" ? "rules" : "knowledge";

    if (category === "rules" && detectedType !== "txt") {
      return res.status(400).json({ error: "Only .txt files are accepted for bot rules policy documents." });
    }

    let parsedContent = rawText || "";

    if (!parsedContent && fileContentBase64) {
      const buffer = Buffer.from(fileContentBase64, "base64");
      if (detectedType === "pdf") {
        try {
          const pdfParse = require("pdf-parse");
          const pdfData = await pdfParse(buffer);
          parsedContent = pdfData.text || "";
        } catch (pdfErr) {
          console.error("PDF parse error in uploadBotFile:", pdfErr);
          parsedContent = buffer.toString("utf-8");
        }
      } else {
        parsedContent = buffer.toString("utf-8");
      }
    }

    if (!parsedContent || typeof parsedContent !== "string" || !parsedContent.trim()) {
      return res.status(400).json({ error: "File content could not be read or extracted." });
    }

    // Validate Rule Limits if file is a Rules Document
    if (category === "rules") {
      const existingRulesFiles = await BotFile.find({ botId, fileCategory: "rules" });
      const combinedRulesText = [...existingRulesFiles.map(f => f.parsedText || ""), parsedContent].join("\n");
      const validation = validateRulesLimits(combinedRulesText);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    // Store BotFile record preserving originalContent and metadata
    const botFile = await BotFile.create({
      botId,
      ownerId: req.user.id,
      userId: req.user.id,
      fileName: cleanName,
      fileType: detectedType,
      fileCategory: category,
      fileSize: Buffer.byteLength(parsedContent, "utf-8"),
      originalContent: parsedContent,
      parsedText: parsedContent
    });

    console.log(`📁 [AUDIT LOG] File Uploaded (${category}): ${cleanName}, Type: ${detectedType}, Size: ${botFile.fileSize} bytes`);

    // Only generate RAG text chunks & embeddings for Knowledge files (NOT Rules files)
    if (category === "knowledge") {
      const chunkSnippets = chunkText(parsedContent, 200, 30);
      const chunkDocs = [];

      for (let i = 0; i < chunkSnippets.length; i++) {
        chunkDocs.push({
          botId,
          userId: req.user.id,
          fileId: botFile._id,
          chunkIndex: i,
          text: chunkSnippets[i].text,
          keywords: chunkSnippets[i].keywords
        });
      }

      if (chunkDocs.length > 0) {
        const insertedChunks = await BotChunk.insertMany(chunkDocs);

        // Create BotEmbeddings vector records using nomic-embed-text
        const embeddingDocs = await Promise.all(
          insertedChunks.map(async (chunk) => ({
            userId: req.user.id,
            botId,
            fileId: botFile._id,
            chunkId: chunk._id,
            text: chunk.text,
            embedding: await generateEmbeddingVectorAsync(chunk.text)
          }))
        );

        await BotEmbedding.insertMany(embeddingDocs);
      }

      botFile.chunkCount = chunkDocs.length;
      await botFile.save();

      const knowledgeMetadata = extractKnowledgeMetadataFromText(parsedContent);
      await Bot.findByIdAndUpdate(botId, {
        $set: {
          knowledgeSummary: {
            titles: Array.from(new Set([...(bot.knowledgeSummary?.titles || []), ...knowledgeMetadata.titles])),
            products: Array.from(new Set([...(bot.knowledgeSummary?.products || []), ...knowledgeMetadata.products])),
            modules: Array.from(new Set([...(bot.knowledgeSummary?.modules || []), ...knowledgeMetadata.modules])),
            topics: Array.from(new Set([...(bot.knowledgeSummary?.topics || []), ...knowledgeMetadata.topics])),
            features: Array.from(new Set([...(bot.knowledgeSummary?.features || []), ...knowledgeMetadata.features])),
            services: Array.from(new Set([...(bot.knowledgeSummary?.services || []), ...knowledgeMetadata.services])),
            headings: Array.from(new Set([...(bot.knowledgeSummary?.headings || []), ...knowledgeMetadata.headings])),
            rawSummary: knowledgeMetadata.rawSummary || (bot.knowledgeSummary?.rawSummary || "")
          },
          knowledgeTopics: Array.from(new Set([...(bot.knowledgeTopics || []), ...knowledgeMetadata.topics])),
          knowledgeModules: Array.from(new Set([...(bot.knowledgeModules || []), ...knowledgeMetadata.modules]))
        }
      });
    } else {
      botFile.chunkCount = 0;
      await botFile.save();
    }

    await syncBotRulesText(botId);

    return res.status(201).json(botFile);
  } catch (err) {
    console.error("Upload Bot File error:", err);
    return res.status(500).json({ error: "Failed to process knowledge upload." });
  }
};

exports.getBotFiles = async (req, res) => {
  try {
    const { botId } = req.params;
    const files = await BotFile.find({
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    }).sort({ createdAt: -1 });

    return res.json(files);
  } catch (err) {
    console.error("Get Bot Files error:", err);
    return res.status(500).json({ error: "Failed to fetch files." });
  }
};

exports.replaceBotFile = async (req, res) => {
  try {
    const { botId, fileId } = req.params;
    const { fileName, fileType, fileCategory, fileContentBase64, rawText } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    const existingFile = await BotFile.findOne({
      _id: fileId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!existingFile) {
      return res.status(404).json({ error: "File to replace was not found." });
    }

    const cleanName = fileName || existingFile.fileName;
    const detectedType = (fileType || cleanName.split(".").pop() || "txt").toLowerCase();
    if (fileCategory) {
      existingFile.fileCategory = fileCategory.toLowerCase() === "rules" ? "rules" : "knowledge";
    }

    if (existingFile.fileCategory === "rules" && detectedType !== "txt") {
      return res.status(400).json({ error: "Only .txt files are accepted for bot rules policy documents." });
    }

    let parsedContent = rawText || "";
    if (!parsedContent && fileContentBase64) {
      const buffer = Buffer.from(fileContentBase64, "base64");
      if (detectedType === "pdf") {
        try {
          const pdfParse = require("pdf-parse");
          const pdfData = await pdfParse(buffer);
          parsedContent = pdfData.text || "";
        } catch (pdfErr) {
          console.error("PDF parse error in replaceBotFile:", pdfErr);
          parsedContent = buffer.toString("utf-8");
        }
      } else {
        parsedContent = buffer.toString("utf-8");
      }
    }

    if (!parsedContent || typeof parsedContent !== "string" || !parsedContent.trim()) {
      return res.status(400).json({ error: "Replacement file content could not be read or parsed." });
    }

    const isRulesCategory = existingFile.fileCategory === "rules";

    // Validate Rule Limits if file is a Rules Document
    if (isRulesCategory) {
      const otherRulesFiles = await BotFile.find({ botId, fileCategory: "rules", _id: { $ne: fileId } });
      const combinedRulesText = [...otherRulesFiles.map(f => f.parsedText || ""), parsedContent].join("\n");
      const validation = validateRulesLimits(combinedRulesText);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }
    }

    // 1. Purge all previous chunks & embeddings for this file
    await BotChunk.deleteMany({ fileId });
    await BotEmbedding.deleteMany({ fileId });

    // 2. Update BotFile record with new document content & size
    existingFile.fileName = cleanName;
    existingFile.fileType = detectedType;
    existingFile.fileSize = Buffer.byteLength(parsedContent, "utf-8");
    existingFile.originalContent = parsedContent;
    existingFile.parsedText = parsedContent;

    // 3. Chunk new content & generate vector embeddings ONLY if Knowledge category
    if (!isRulesCategory) {
      const chunkSnippets = chunkText(parsedContent, 200, 30);
      const chunkDocs = [];

      for (let i = 0; i < chunkSnippets.length; i++) {
        chunkDocs.push({
          botId,
          userId: req.user.id,
          fileId: existingFile._id,
          chunkIndex: i,
          text: chunkSnippets[i].text,
          keywords: chunkSnippets[i].keywords
        });
      }

      if (chunkDocs.length > 0) {
        const insertedChunks = await BotChunk.insertMany(chunkDocs);

        const embeddingDocs = await Promise.all(
          insertedChunks.map(async (chunk) => ({
            userId: req.user.id,
            botId,
            fileId: existingFile._id,
            chunkId: chunk._id,
            text: chunk.text,
            embedding: await generateEmbeddingVectorAsync(chunk.text)
          }))
        );

        await BotEmbedding.insertMany(embeddingDocs);
      }

      existingFile.chunkCount = chunkDocs.length;
      await existingFile.save();

      // 4. Update knowledge metadata summary
      const knowledgeMetadata = extractKnowledgeMetadataFromText(parsedContent);
      await Bot.findByIdAndUpdate(botId, {
        $set: {
          knowledgeSummary: {
            titles: Array.from(new Set([...(bot.knowledgeSummary?.titles || []), ...knowledgeMetadata.titles])),
            products: Array.from(new Set([...(bot.knowledgeSummary?.products || []), ...knowledgeMetadata.products])),
            modules: Array.from(new Set([...(bot.knowledgeSummary?.modules || []), ...knowledgeMetadata.modules])),
            topics: Array.from(new Set([...(bot.knowledgeSummary?.topics || []), ...knowledgeMetadata.topics])),
            features: Array.from(new Set([...(bot.knowledgeSummary?.features || []), ...knowledgeMetadata.features])),
            services: Array.from(new Set([...(bot.knowledgeSummary?.services || []), ...knowledgeMetadata.services])),
            headings: Array.from(new Set([...(bot.knowledgeSummary?.headings || []), ...knowledgeMetadata.headings])),
            rawSummary: knowledgeMetadata.rawSummary || (bot.knowledgeSummary?.rawSummary || "")
          },
          knowledgeTopics: Array.from(new Set([...(bot.knowledgeTopics || []), ...knowledgeMetadata.topics])),
          knowledgeModules: Array.from(new Set([...(bot.knowledgeModules || []), ...knowledgeMetadata.modules]))
        }
      });
    } else {
      existingFile.chunkCount = 0;
      await existingFile.save();
    }

    await syncBotRulesText(botId);

    console.log(`📁 [AUDIT LOG] Knowledge File Replaced Successfully: ${cleanName}, New Size: ${existingFile.fileSize} bytes, Chunks: ${chunkDocs.length}`);
    return res.json(existingFile);
  } catch (err) {
    console.error("Replace Bot File error:", err);
    return res.status(500).json({ error: "Failed to replace knowledge file." });
  }
};

exports.deleteBotFile = async (req, res) => {
  try {
    const { botId, fileId } = req.params;
    const file = await BotFile.findOneAndDelete({
      _id: fileId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!file) {
      return res.status(404).json({ error: "File not found or unauthorized." });
    }

    await BotChunk.deleteMany({ fileId });
    await BotEmbedding.deleteMany({ fileId });

    await syncBotRulesText(botId);

    return res.json({ message: "Knowledge file deleted successfully." });
  } catch (err) {
    console.error("Delete Bot File error:", err);
    return res.status(500).json({ error: "Failed to delete file." });
  }
};

// -----------------------------------------------------------------------------
// 3. BOT API INTEGRATION CONTROLLERS
// -----------------------------------------------------------------------------

exports.createBotApi = async (req, res) => {
  try {
    const { botId } = req.params;
    const { name, url, method, headers, authType, apiKey, bearerToken, requestMapping } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const apiItem = await BotApi.create({
      botId,
      ownerId: req.user.id,
      userId: req.user.id,
      name: name.trim(),
      url: url.trim(),
      method: method || "GET",
      headers: headers || {},
      authType: authType || "none",
      encryptedApiKey: apiKey ? encrypt(apiKey) : null,
      encryptedBearerToken: bearerToken ? encrypt(bearerToken) : null,
      requestMapping: requestMapping || ""
    });

    return res.status(201).json({
      _id: apiItem._id,
      name: apiItem.name,
      url: apiItem.url,
      method: apiItem.method,
      authType: apiItem.authType,
      hasApiKey: !!apiItem.encryptedApiKey,
      hasBearerToken: !!apiItem.encryptedBearerToken
    });
  } catch (err) {
    console.error("Create Bot API error:", err);
    return res.status(500).json({ error: "Failed to create API integration." });
  }
};

exports.getBotApis = async (req, res) => {
  try {
    const { botId } = req.params;
    const apis = await BotApi.find({
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    }).sort({ createdAt: -1 });

    const maskedApis = apis.map((a) => ({
      _id: a._id,
      botId: a.botId,
      name: a.name,
      url: a.url,
      method: a.method,
      headers: a.headers,
      authType: a.authType,
      hasApiKey: !!a.encryptedApiKey,
      hasBearerToken: !!a.encryptedBearerToken,
      requestMapping: a.requestMapping,
      createdAt: a.createdAt
    }));

    return res.json(maskedApis);
  } catch (err) {
    console.error("Get Bot APIs error:", err);
    return res.status(500).json({ error: "Failed to fetch API integrations." });
  }
};

exports.deleteBotApi = async (req, res) => {
  try {
    const { botId, apiId } = req.params;
    const apiItem = await BotApi.findOneAndDelete({
      _id: apiId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!apiItem) {
      return res.status(404).json({ error: "API integration not found." });
    }
    return res.json({ message: "API integration deleted successfully." });
  } catch (err) {
    console.error("Delete Bot API error:", err);
    return res.status(500).json({ error: "Failed to delete API integration." });
  }
};

exports.updateBotApi = async (req, res) => {
  try {
    const { botId, apiId } = req.params;
    const { name, url, method, authType, apiKey } = req.body;

    const apiItem = await BotApi.findOne({
      _id: apiId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!apiItem) {
      return res.status(404).json({ error: "API integration not found or unauthorized." });
    }

    if (name) apiItem.name = name.trim();
    if (url) apiItem.url = url.trim();
    if (method) apiItem.method = method;
    if (authType) apiItem.authType = authType;
    if (apiKey) apiItem.encryptedApiKey = encrypt(apiKey);

    await apiItem.save();
    return res.json({ success: true, message: "API integration updated successfully.", api: apiItem });
  } catch (err) {
    console.error("Update Bot API error:", err);
    return res.status(500).json({ error: "Failed to update API integration." });
  }
};

exports.testBotApi = async (req, res) => {
  try {
    const { botId, apiId } = req.params;
    const apiItem = await BotApi.findOne({
      _id: apiId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!apiItem) {
      return res.status(404).json({ error: "API integration not found." });
    }

    const headers = { ...apiItem.headers };
    if (apiItem.authType === "apiKey" && apiItem.encryptedApiKey) {
      headers["x-api-key"] = decrypt(apiItem.encryptedApiKey);
    } else if (apiItem.authType === "bearerToken" && apiItem.encryptedBearerToken) {
      headers["Authorization"] = `Bearer ${decrypt(apiItem.encryptedBearerToken)}`;
    }

    const response = await fetch(apiItem.url, {
      method: apiItem.method,
      headers
    });

    const status = response.status;
    let data;
    try {
      data = await response.json();
    } catch (e) {
      data = await response.text();
    }

    return res.json({
      status,
      ok: response.ok,
      data
    });
  } catch (err) {
    console.error("Test Bot API error:", err.message);
    return res.status(500).json({ error: `API Execution failed: ${err.message}` });
  }
};

/**
 * Helper to pass raw AI response text directly to frontend.
 * Frontend ReactMarkdown handles tables, lists, and markdown formatting natively.
 */
function parseStructuredUI(text) {
  const trimmed = (text || "").trim();
  return {
    component: "text",
    title: "Response",
    data: { text: trimmed }
  };
}

function sendJsonResponse(res, conversation, bot, currentBotMode, responseText, sourcesMeta = [], reqStartTime = 0, ttft = null) {
  const totalDuration = performance.now() - reqStartTime;
  const structuredUI = parseStructuredUI(responseText);

  return res.json({
    success: true,
    conversationId: conversation._id,
    botId: bot._id,
    botName: bot.name || "AI Assistant",
    botMode: currentBotMode,
    responseType: "markdown",
    message: {
      role: "assistant",
      content: responseText
    },
    sources: sourcesMeta,
    structuredUI,
    metrics: {
      ttftMs: ttft !== null ? Number(ttft.toFixed(2)) : null,
      totalDurationMs: Number(totalDuration.toFixed(2))
    }
  });
}

// -----------------------------------------------------------------------------
// 4. RAG-POWERED BOT CHAT CONTROLLER WITH DUAL-MODE (SSE STREAMING & STRUCTURED JSON UI)
// -----------------------------------------------------------------------------

exports.sendBotChatMessage = async (req, res) => {
  const reqStartTime = performance.now();
  let dbFetchTime = 0;
  let ragSearchTime = 0;
  let ttft = null;
  let streamDuration = 0;
  let firstTokenTimestamp = null;
  let llmRequestStartTime = null;

  try {
    const { botId } = req.params;
    const { message, conversationId } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message content is required." });
    }

    const tDbStart = performance.now();
    const { getCache, setCache } = require("../utils/redisClient");
    const botCacheKey = `bot_cfg_${botId}_${req.user.id}`;
    let bot = await getCache(botCacheKey);

    if (!bot) {
      bot = await Bot.findOne({
        _id: botId,
        $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
      }).lean();
      if (bot) {
        await setCache(botCacheKey, bot, 300); // Cache for 5 minutes in Redis
      }
    }

    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const { chatId, sessionId, visitorId } = req.body;
    const effectiveVisitorId = visitorId || (req.headers["x-visitor-id"] ? String(req.headers["x-visitor-id"]).trim() : null);

    let conversation;
    const sessionKey = (effectiveVisitorId && botId) ? `bot:${botId}:vis:${effectiveVisitorId}` : null;

    // 1. Explicit conversationId check
    const targetId = conversationId || chatId || sessionId;
    if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
      conversation = await BotConversation.findOne({
        _id: targetId,
        botId,
        $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
      });
    }

    // 2. Redis O(1) Session Lookup for visitorId
    if (!conversation && sessionKey) {
      const cachedConvId = await getCache(sessionKey);
      if (cachedConvId) {
        conversation = await BotConversation.findOne({
          _id: cachedConvId,
          botId,
          $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
        });
      }

      // 3. Fallback check in MongoDB (handles Redis restart or cache eviction gracefully)
      if (!conversation) {
        const candidate = await BotConversation.findOne({
          botId,
          visitorId: effectiveVisitorId,
          $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
        }).sort({ updatedAt: -1 });

        if (candidate) {
          const HALF_HOUR_MS = 30 * 60 * 1000;
          const isRecentlyActive = (new Date() - new Date(candidate.updatedAt)) < HALF_HOUR_MS;
          if (isRecentlyActive) {
            conversation = candidate;
          }
        }
      }
    }

    // 4. Create new conversation if no active thread exists
    if (!conversation) {
      conversation = await BotConversation.create({
        botId,
        ownerId: req.user.id,
        userId: req.user.id,
        visitorId: effectiveVisitorId || "",
        title: message.trim().substring(0, 35) || "New Conversation"
      });
    } else if (!conversation.title || conversation.title === "New Conversation" || conversation.title === "New Bot Conversation") {
      conversation.title = message.trim().substring(0, 35) || "New Conversation";
      await conversation.save();
    }

    // Refresh sliding 30-minute Redis TTL for active session
    if (sessionKey && conversation) {
      await setCache(sessionKey, String(conversation._id), 1800);
    }

    // Detect response format requested by client
    const acceptHeader = (req.headers.accept || "").toLowerCase();
    const isStreamRequested = (req.body.stream === true) || acceptHeader.includes("text/event-stream") || (req.body.stream !== false && !acceptHeader.includes("application/json"));

    if (isStreamRequested) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: metadata\ndata: ${JSON.stringify({ type: "meta", responseType: "markdown", title: conversation.title || "Bot Conversation", conversationId: conversation._id, chatId: conversation._id, visitorId: effectiveVisitorId })}\n\n`);
    }

    // Rolling Context Window: Fetch last 6 messages (3 turns) for bounded LLM prompt token footprint
    const historyMessages = await BotMessage.find({ conversationId: conversation._id, botId })
      .sort({ createdAt: -1 })
      .limit(6);
    const sortedHistory = historyMessages.reverse();

    // Async background LLM summarization trigger (every 8 messages after 16 threshold)
    const totalMsgCount = await BotMessage.countDocuments({ conversationId: conversation._id });
    if (totalMsgCount >= 16 && totalMsgCount % 8 === 0) {
      generateLLMSummary(sortedHistory, conversation.conversationSummary)
        .then((newSummary) => {
          if (newSummary) {
            BotConversation.findByIdAndUpdate(conversation._id, { conversationSummary: newSummary }).catch(() => { });
          }
        })
        .catch(() => { });
    }

    dbFetchTime = performance.now() - tDbStart;

    // Team Escalation Pipeline Check (Grounding Matrix Mandate)
    if (/\b(platform\s+setup|pricing\s+matrix|custom\s+automation|deep\s+explanation|complex\s+setup)\b/i.test(message.trim())) {
      const escalationResponse = "I will gladly capture your primary context details right here to instantly connect you directly with our specialized engineering team for a full custom walkthrough.";
      await streamTextInChunks(res, escalationResponse, 15);

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "user",
        content: message
      });

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "assistant",
        content: escalationResponse
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Knowledge overview questions answered from stored metadata before vector search
    const botFiles = await BotFile.find({ botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] })
      .sort({ createdAt: -1 })
      .limit(6)
      .select("fileName");

    const overviewResponse = buildKnowledgeOverviewResponse(bot, botFiles.map(f => f.fileName), message);
    if (overviewResponse) {
      await streamTextInChunks(res, overviewResponse, 15);

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "user",
        content: message
      });

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "assistant",
        content: overviewResponse
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // -----------------------------------------------------------------------------
    // TOOL CALLING ENGINE & ACTION INTENT EXECUTION
    // -----------------------------------------------------------------------------
    const { detectActionIntent, extractPayloadFromMessage, executeToolApi } = require("../services/toolCallingEngine");
    const configuredApis = await BotApi.find({ botId, enabled: true });
    const detectedAction = detectActionIntent(message);

    // If an action intent is requested by the user
    if (detectedAction || /\b(create|add|register|update|modify|delete|remove)\s+(a\s+)?(contact|lead|ticket|account|record|email)\b/i.test(message)) {
      const matchedApi = configuredApis.find(a => a.actionType === detectedAction || (detectedAction && a.actionType === "GENERIC"));

      // 1. Missing API Integration Case
      if (!matchedApi) {
        const missingApiMsg = "I cannot perform this action because no API integration is currently configured for this operation.\n\nTo enable this capability, please add the required API in the API Integrations section and reconnect the bot.";
        await streamTextInChunks(res, missingApiMsg, 15);

        await BotMessage.create({
          conversationId: conversation._id,
          botId,
          userId: req.user.id,
          role: "user",
          content: message
        });

        await BotMessage.create({
          conversationId: conversation._id,
          botId,
          userId: req.user.id,
          role: "assistant",
          content: missingApiMsg
        });

        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // 2. Parameter Validation Case
      const payload = extractPayloadFromMessage(message);
      if (detectedAction === "CREATE_CONTACT" && (!payload.name && !payload.firstName) && !payload.email && !payload.phone) {
        const missingParamsMsg = "I can perform this action. Please provide the required fields: Name, Email, and Phone Number.";
        await streamTextInChunks(res, missingParamsMsg, 15);

        await BotMessage.create({
          conversationId: conversation._id,
          botId,
          userId: req.user.id,
          role: "user",
          content: message
        });

        await BotMessage.create({
          conversationId: conversation._id,
          botId,
          userId: req.user.id,
          role: "assistant",
          content: missingParamsMsg
        });

        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // 3. Execute Tool API
      const toolResult = await executeToolApi(matchedApi, payload);

      let actionResponseText = "";
      if (toolResult.success) {
        actionResponseText = `⚡ **Action Executed Successfully** via tool **${matchedApi.name}** (${matchedApi.method} ${toolResult.endpoint}):\n\n\`\`\`json\n${JSON.stringify(toolResult.data, null, 2)}\n\`\`\``;
      } else {
        actionResponseText = `⚠️ **Tool Action Failed** via **${matchedApi.name}**: ${toolResult.error || `HTTP Status ${toolResult.statusCode}`}`;
      }

      await streamTextInChunks(res, actionResponseText, 15);

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "user",
        content: message
      });

      await BotMessage.create({
        conversationId: conversation._id,
        botId,
        userId: req.user.id,
        role: "assistant",
        content: actionResponseText
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Intent classification via Smart Intent Router
    const intent = detectBotIntent(message, bot.knowledgeSummary);

    // Extract bot mode: small (Strict Document Only), medium (Balanced Hybrid), large (Omni AI)
    const rawBotMode = (bot.botMode || bot.model || "small").toLowerCase();
    const currentBotMode = ["small", "medium", "large"].includes(rawBotMode) ? rawBotMode : "small";

    let isGeneralQuery = (intent === "GENERAL_QUERY" || intent === "GENERAL_CONVERSATION" || intent === "GREETING");

    // In SMALL Mode (Strict Knowledge Bot), non-greeting queries force document RAG search
    if (currentBotMode === "small" && intent !== "GREETING") {
      isGeneralQuery = false;
    }

    let ragResult = { isFound: true, chunks: [] };

    // Check if bot has uploaded document files
    const hasFilesCount = await BotFile.countDocuments({ botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] });
    const hasUploadedFiles = hasFilesCount > 0;

    if (intent !== "GREETING" && hasUploadedFiles) {
      // Multi-tenant Isolated Knowledge Retrieval for Document / API questions
      const tRagStart = performance.now();
      ragResult = await retrieveRelevantChunks(req.user.id, botId, message, 3, sortedHistory, bot.knowledgeSummary);
      ragSearchTime = performance.now() - tRagStart;
    }

    const sourcesMeta = ragResult.isFound && ragResult.chunks.length > 0
      ? ragResult.chunks.map(c => ({ fileName: c.fileName, snippet: c.snippet.substring(0, 100) + "..." }))
      : [];

    // Production-Grade Terminal Diagnostic Logging
    console.log(`
🤖 =================== [BOT CHAT ROUTER DIAGNOSTICS] ===================
  📌 Bot Name:           ${bot.name || "AI Bot"} (ID: ${botId})
  🎯 Bot Mode Preset:    ${currentBotMode.toUpperCase()} (${currentBotMode === 'small' ? 'Strict Document Only' : currentBotMode === 'medium' ? 'Balanced Hybrid' : 'Omni General & RAG'})
  💬 User Prompt:        "${message}"
  🏷️ Classified Intent:   ${intent}
  📂 Uploaded Files:      ${hasUploadedFiles ? `YES (${hasFilesCount} Files)` : "NO"}
  ${hasUploadedFiles && intent !== "GREETING"
        ? `📄 RAG Decision:        [EXECUTED] Document Grounding Search (${ragSearchTime.toFixed(2)} ms | Chunks: ${ragResult.chunks?.length || 0})`
        : `⚡ RAG Decision:        [BYPASSED] General Conversation Mode (0ms DB Overhead)`}
  🧠 System Prompt:       ${(hasUploadedFiles || ragResult.chunks?.length > 0) ? "buildRagSystemPrompt (Strict Grounding + Sources)" : `buildGeneralSystemPrompt (${currentBotMode.toUpperCase()})`}
========================================================================\n`);

    if (sourcesMeta.length > 0 && isStreamRequested) {
      res.write(`event: sources\ndata: ${JSON.stringify({ type: "sources", sources: sourcesMeta })}\n\n`);
    }

    // Fetch compiled rules object from Redis cache (bot:${botId}:rules) with 0ms runtime overhead
    const rulesCacheKey = `bot:${botId}:rules`;
    let cachedRulesObj = await getCache(rulesCacheKey);

    if (!cachedRulesObj) {
      const rawText = (bot.rulesConfig?.rulesText || "").trim();
      const rulesLines = rawText.split(/\r?\n/).filter(l => l.trim().length > 0);
      cachedRulesObj = {
        rulesText: rawText,
        rulesCount: rulesLines.length,
        wantsScheduleCard: /\b(schedule|call|agent|human|appointment|meeting|card|contact|escalat)\b/i.test(rawText),
        rulesList: rulesLines
      };
      if (rawText) {
        await setCache(rulesCacheKey, cachedRulesObj, 3600);
      }
    }

    const effectiveRulesText = typeof cachedRulesObj === "object" ? (cachedRulesObj.rulesText || "") : String(cachedRulesObj || "");

    // Build system prompt based on adaptive intent and currentBotMode
    const { buildGeneralSystemPrompt } = require("../utils/ragEngine");
    let systemPrompt;
    if (intent === "GREETING" && !hasUploadedFiles) {
      systemPrompt = buildGeneralSystemPrompt(bot.name, bot.description, currentBotMode, effectiveRulesText);
    } else {
      systemPrompt = buildRagSystemPrompt(bot.name, bot.description, ragResult.chunks, configuredApis, bot.knowledgeSummary, effectiveRulesText, currentBotMode);
    }

    const aiGateway = require("../utils/aiGateway");
    const { calculatePriority } = require("../utils/priorityCalculator");
    const User = require("../models/User");

    const userId = req.user?.id || req.user?._id;
    const userDoc = userId ? await User.findById(userId).select("plan") : null;
    const userPlan = userDoc?.plan || req.user?.plan || req.headers["x-user-plan"] || "free";
    const userPriority = await calculatePriority(userPlan);

    const jobId = `bot_${botId}_${Date.now()}`;
    const targetModel = bot.model || "best";

    // Construct clean, non-duplicative messages array for AI Gateway
    const ollamaMessages = [
      { role: "system", content: systemPrompt }
    ];

    if (conversation.conversationSummary && conversation.conversationSummary.trim()) {
      ollamaMessages.push({
        role: "system",
        content: `Conversation Summary:\n${conversation.conversationSummary}`
      });
    }

    sortedHistory.forEach(m => {
      ollamaMessages.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
      });
    });

    ollamaMessages.push({ role: "user", content: message });

    llmRequestStartTime = performance.now();

    const gatewayResult = await aiGateway.generateStream({
      provider: "auto",
      model: targetModel,
      messages: ollamaMessages,
      conversationSummary: conversation.conversationSummary || "",
      res: isStreamRequested ? res : null,
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

    if (!streamedSuccessfully || !accumulatedResponseText.trim()) {
      if (res.writableEnded) {
        return;
      }
      if (!ragResult.isFound) {
        accumulatedResponseText = "I couldn't find information about that in the uploaded knowledge base.";
      } else {
        accumulatedResponseText = "I encountered an issue generating a response. Please check that Ollama is running locally.";
      }
      if (isStreamRequested) {
        await streamTextInChunks(res, accumulatedResponseText, 15);
      }
    }

    await BotMessage.create({
      conversationId: conversation._id,
      botId,
      userId: req.user.id,
      role: "user",
      content: message
    });

    await BotMessage.create({
      conversationId: conversation._id,
      botId,
      userId: req.user.id,
      role: "assistant",
      content: accumulatedResponseText,
      sources: sourcesMeta
    });

    // Non-blocking background trigger for provider-aware rolling summary
    memoryService.triggerBackgroundSummaryUpdate(conversation._id, botId);

    const totalDuration = performance.now() - reqStartTime;
    if (firstTokenTimestamp) {
      streamDuration = performance.now() - firstTokenTimestamp;
    }

    console.log(`
⏱️  =================== [LATENCY DIAGNOSTICS BREAKDOWN] ===================
  📌 Route: Bot Chat ${isStreamRequested ? 'Stream (SSE)' : 'REST (JSON)'} (/api/v1/bots/${botId}/chat)
  ├── 🗄️ Database Operations:          ${dbFetchTime.toFixed(2)} ms
  ├── 🧠 RAG & Vector Search:           ${ragSearchTime.toFixed(2)} ms
  ├── 🚀 Time To First Token (TTFT):   ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A'}
  ├── ⚡ Token Streaming Duration:     ${streamDuration > 0 ? streamDuration.toFixed(2) + ' ms' : 'N/A'}
  └── 🏁 TOTAL REQUEST DURATION:        ${totalDuration.toFixed(2)} ms
========================================================================\n
`);

    if (isStreamRequested) {
      const structuredUI = parseStructuredUI(accumulatedResponseText);
      res.write(`event: metadata\ndata: ${JSON.stringify({ responseType: structuredUI.component, title: conversation.title || "Bot Conversation", conversationId: conversation._id })}\n\n`);
      res.write("event: done\ndata: [DONE]\n\n");
      return res.end();
    } else {
      return sendJsonResponse(res, conversation, bot, currentBotMode, accumulatedResponseText, sourcesMeta, reqStartTime, ttft);
    }
  } catch (err) {
    console.error("Bot Chat Streaming error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Bot chat generation failed." });
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
};

exports.getBotConversations = async (req, res) => {
  try {
    const { botId } = req.params;
    const conversations = await BotConversation.find({
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    }).sort({ createdAt: -1 });

    return res.json(conversations);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch bot conversations." });
  }
};

exports.createBotConversation = async (req, res) => {
  try {
    const { botId } = req.params;
    const { title } = req.body;
    const conversation = await BotConversation.create({
      botId,
      ownerId: req.user.id,
      userId: req.user.id,
      title: title || "New Bot Conversation"
    });
    return res.status(201).json(conversation);
  } catch (err) {
    return res.status(500).json({ error: "Failed to create conversation." });
  }
};

exports.deleteBotConversation = async (req, res) => {
  try {
    const { botId, conversationId } = req.params;
    const conversation = await BotConversation.findOneAndDelete({
      _id: conversationId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found or unauthorized." });
    }
    await BotMessage.deleteMany({ conversationId });
    await Summary.deleteOne({ chatId: conversationId });
    return res.json({ message: "Bot conversation deleted successfully." });
  } catch (err) {
    return res.status(500).json({ error: "Failed to delete conversation." });
  }
};

exports.getBotMessages = async (req, res) => {
  try {
    const { botId, conversationId } = req.params;
    const messages = await BotMessage.find({ conversationId, botId }).sort({ createdAt: 1 });
    return res.json(messages);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch bot messages." });
  }
};

exports.importPostmanCollection = async (req, res) => {
  try {
    const { botId } = req.params;
    const { collectionJson, collectionName } = req.body;
    const userId = req.user?.id || req.user?._id || req.user?.userId;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId }, { ownerId: userId }]
    }) || await Bot.findById(botId);

    if (!bot) {
      return res.status(404).json({ success: false, message: "Bot not found or unauthorized." });
    }

    const { parsePostmanCollection } = require("../utils/postmanParser");
    const parseResult = parsePostmanCollection(collectionJson);

    if (!parseResult.success || parseResult.endpoints.length === 0) {
      return res.status(400).json({ success: false, message: parseResult.error || "Failed to parse Postman Collection JSON." });
    }

    const PostmanApi = require("../models/PostmanApi");
    const savedApis = [];

    for (const ep of parseResult.endpoints) {
      const created = await PostmanApi.create({
        botId,
        ownerId: bot.ownerId || userId,
        userId: userId || bot.userId,
        collectionName: ep.collectionName || collectionName || parseResult.collectionName || "Postman Collection",
        name: ep.name,
        method: ep.method,
        url: ep.url,
        headers: ep.headers || [],
        queryParams: ep.queryParams || [],
        body: ep.body || {},
        description: ep.description || "",
        tags: ep.tags || []
      });
      savedApis.push(created);
    }

    return res.status(200).json({
      success: true,
      message: `Successfully imported ${savedApis.length} API endpoints from Postman collection "${parseResult.collectionName}".`,
      count: savedApis.length,
      endpoints: savedApis
    });
  } catch (err) {
    console.error("Postman import error:", err);
    return res.status(500).json({ success: false, message: "Failed to import Postman collection.", error: err.message });
  }
};

exports.getPostmanApis = async (req, res) => {
  try {
    const { botId } = req.params;
    const PostmanApi = require("../models/PostmanApi");
    const apis = await PostmanApi.find({ botId }).sort({ createdAt: -1 });

    return res.json({ success: true, count: apis.length, apis });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to fetch Postman APIs." });
  }
};

exports.deletePostmanApi = async (req, res) => {
  try {
    const { botId, apiId } = req.params;
    const PostmanApi = require("../models/PostmanApi");
    const deleted = await PostmanApi.findOneAndDelete({
      _id: apiId,
      botId
    });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Postman API not found." });
    }

    return res.json({ success: true, message: "Postman API deleted successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to delete Postman API." });
  }
};

exports.updatePostmanApi = async (req, res) => {
  try {
    const { botId, apiId } = req.params;
    const { name, url, method, description } = req.body;

    const PostmanApi = require("../models/PostmanApi");
    const pApi = await PostmanApi.findOne({
      _id: apiId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!pApi) {
      return res.status(404).json({ success: false, message: "Postman API not found or unauthorized." });
    }

    if (name) pApi.name = name.trim();
    if (url) pApi.url = url.trim();
    if (method) pApi.method = method.toUpperCase();
    if (description !== undefined) pApi.description = description;

    await pApi.save();
    return res.json({ success: true, message: "Postman API updated successfully.", api: pApi });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to update Postman API." });
  }
};

/**
 * Dedicated Route to Generate / Issue API Key and Secret Key for a Bot
 * Endpoint: POST /bots/:botId/keys/generate (or POST /bots/:botId/keys)
 */
exports.generateBotKeys = async (req, res) => {
  try {
    const crypto = require("crypto");
    const mongoose = require("mongoose");
    const { botId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(botId)) {
      return res.status(400).json({ success: false, message: "Validation error: Invalid Bot ID format. Must be a 24-character hex string." });
    }

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!bot) {
      return res.status(404).json({ success: false, message: "Bot not found or unauthorized." });
    }

    bot.apiKey = `bot_pk_${crypto.randomBytes(16).toString("hex")}`;
    bot.secretKey = `bot_sk_${crypto.randomBytes(24).toString("hex")}`;
    bot.keyCreatedAt = new Date();
    await bot.save();

    const hostUrl = process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`;
    const chatUrl = `${hostUrl.replace(/\/$/, "")}/api/v1/external/bots/chat`;

    return res.status(201).json({
      success: true,
      message: "Bot API Key and Secret Key generated successfully.",
      botId: bot._id,
      botName: bot.name,
      apiKey: bot.apiKey,
      secretKey: bot.secretKey,
      keyCreatedAt: bot.keyCreatedAt,
      chatUrl
    });
  } catch (err) {
    console.error("Generate Bot Keys Error:", err);
    return res.status(500).json({ success: false, message: "Failed to generate Bot keys.", error: err.message });
  }
};

/**
 * Get active API Key and Secret Key metadata for a Bot
 * Endpoint: GET /bots/:botId/keys
 */
exports.getBotKeys = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const { botId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(botId)) {
      return res.status(400).json({ success: false, message: "Validation error: Invalid Bot ID format. Must be a 24-character hex string." });
    }

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!bot) {
      return res.status(404).json({ success: false, message: "Bot not found or unauthorized." });
    }

    const hostUrl = process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`;
    const chatUrl = `${hostUrl.replace(/\/$/, "")}/api/v1/external/bots/chat`;

    if (!bot.apiKey || !bot.secretKey) {
      return res.json({
        success: true,
        hasKeys: false,
        message: "No API Key or Secret Key has been generated for this bot yet.",
        chatUrl
      });
    }

    return res.json({
      success: true,
      hasKeys: true,
      botId: bot._id,
      botName: bot.name,
      apiKey: bot.apiKey,
      secretKey: bot.secretKey,
      keyCreatedAt: bot.keyCreatedAt,
      keyLastUsedAt: bot.keyLastUsedAt,
      chatUrl
    });
  } catch (err) {
    console.error("Get Bot Keys Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch Bot keys.", error: err.message });
  }
};

/**
 * Revokes / Invalidates API Key and Secret Key for a Bot
 * Endpoint: DELETE /bots/:botId/keys (or POST /bots/:botId/keys/revoke)
 */
exports.revokeBotKeys = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const { botId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(botId)) {
      return res.status(400).json({ success: false, message: "Validation error: Invalid Bot ID format. Must be a 24-character hex string." });
    }

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });

    if (!bot) {
      return res.status(404).json({ success: false, message: "Bot not found or unauthorized." });
    }

    bot.apiKey = undefined;
    bot.secretKey = undefined;
    bot.keyCreatedAt = undefined;
    await bot.save();

    return res.json({
      success: true,
      message: "Bot API Key and Secret Key revoked successfully. External integrations using these keys will no longer work."
    });
  } catch (err) {
    console.error("Revoke Bot Keys Error:", err);
    return res.status(500).json({ success: false, message: "Failed to revoke Bot keys.", error: err.message });
  }
};

/**
 * Regenerates / rotates API Key and Secret Key for a Bot
 * Endpoint: POST /bots/:botId/keys/rotate
 */
exports.rotateBotKeys = async (req, res) => {
  return exports.generateBotKeys(req, res);
};

/**
 * Public External Chat Endpoint authenticated via Bot API Key & Secret Key
 * Endpoint: POST /api/v1/external/bots/chat
 */
exports.externalBotChat = async (req, res) => {
  try {
    const bot = req.bot; // Attached by botKeyAuth middleware
    const { message, conversationId, visitorId, chatId, sessionId } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, message: "Validation error: 'message' payload is required and must be a non-empty string." });
    }

    if (message.trim().length > 4000) {
      return res.status(400).json({ success: false, message: "Validation error: 'message' payload exceeds maximum limit of 4000 characters." });
    }

    req.body.conversationId = conversationId || chatId || sessionId;
    req.body.visitorId = visitorId || req.headers["x-visitor-id"];

    // Pass botId & owner user context
    req.params.botId = bot._id.toString();
    req.user = { id: (bot.ownerId || bot.userId).toString() };

    return exports.sendBotChatMessage(req, res);
  } catch (err) {
    console.error("External Bot Chat Error:", err);
    return res.status(500).json({ success: false, message: "Failed to process external bot chat message.", error: err.message });
  }
};
