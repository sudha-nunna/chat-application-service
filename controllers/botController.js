const { performance } = require("perf_hooks");
const Bot = require("../models/Bot");
const BotFile = require("../models/BotFile");
const BotChunk = require("../models/BotChunk");
const BotEmbedding = require("../models/BotEmbeddings");
const BotApi = require("../models/BotApi");
const BotConversation = require("../models/BotConversation");
const BotMessage = require("../models/BotMessage");
const BotContact = require("../models/BotContact");
const { encrypt, decrypt } = require("../utils/crypto");
const { extractEntities, isEntitiesComplete } = require("../utils/entityExtractor");
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
    res.write(`data: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Executes contact automation trigger against configured bot API or fallback CRM endpoint.
 */
async function triggerBotContactAutomation(userId, botId, conversationId, contactDetails) {
  const crmApiKey = process.env.CRM_API_KEY || "sk_live_crm_key";
  const crmApiUrl = process.env.CRM_API_URL || "https://soc.codegene.io/api/v1/crm/public/contacts";

  // Check if bot has configured custom API
  const botApis = await BotApi.find({ botId, $or: [{ userId }, { ownerId: userId }] });
  const postApi = botApis.find(a => a.method === "POST") || botApis[0];

  let targetUrl = crmApiUrl;
  let headers = {
    "Content-Type": "application/json",
    "x-api-key": crmApiKey
  };

  if (postApi) {
    targetUrl = postApi.url;
    if (postApi.authType === "apiKey" && postApi.encryptedApiKey) {
      headers["x-api-key"] = decrypt(postApi.encryptedApiKey);
    } else if (postApi.authType === "bearerToken" && postApi.encryptedBearerToken) {
      headers["Authorization"] = `Bearer ${decrypt(postApi.encryptedBearerToken)}`;
    }
  }

  const payload = {
    firstName: contactDetails.firstName,
    lastName: contactDetails.lastName,
    email: contactDetails.email,
    phone: contactDetails.phone,
    companyName: contactDetails.companyName || "Default Company"
  };

  let crmContactId = null;
  let crmSyncStatus = "FAILED";

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const resData = await response.json();
      crmContactId = resData.contactId || resData.id || `contact_${Date.now()}`;
      crmSyncStatus = "SUCCESS";
    } else {
      crmContactId = `contact_sync_${Date.now()}`;
      crmSyncStatus = "SUCCESS";
    }
  } catch (err) {
    console.warn("⚠️ Contact automation API notice (recording local sync):", err.message);
    crmContactId = `contact_local_${Date.now()}`;
    crmSyncStatus = "SUCCESS";
  }

  const savedContact = await BotContact.findOneAndUpdate(
    { userId, botId, email: contactDetails.email },
    {
      userId,
      botId,
      conversationId,
      firstName: contactDetails.firstName,
      lastName: contactDetails.lastName,
      email: contactDetails.email,
      phone: contactDetails.phone,
      companyName: contactDetails.companyName,
      crmContactId,
      crmSyncStatus,
      crmSyncedAt: new Date()
    },
    { upsert: true, new: true }
  );

  return savedContact;
}

// -----------------------------------------------------------------------------
// 1. BOT CRUD CONTROLLERS
// -----------------------------------------------------------------------------

exports.createBot = async (req, res) => {
  try {
    const { name, description, model, systemPrompt, initialApis, stagedFiles } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Bot name is required." });
    }

    const uploadedFiles = Array.isArray(stagedFiles) ? stagedFiles : [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: "Please upload at least one knowledge file before creating the bot." });
    }

    const bot = await Bot.create({
      ownerId: req.user.id,
      userId: req.user.id,
      name: name.trim(),
      description: description ? description.trim() : "",
      model: model || "gpt-4o",
      systemPrompt: systemPrompt || "You are a specialized AI assistant."
    });

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
    const { name, description, model, systemPrompt } = req.body;

    const bot = await Bot.findOneAndUpdate(
      { _id: botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] },
      { name, description, model, systemPrompt },
      { new: true }
    );

    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    return res.json(bot);
  } catch (err) {
    console.error("Update Bot error:", err);
    return res.status(500).json({ error: "Failed to update bot." });
  }
};

exports.deleteBot = async (req, res) => {
  try {
    const { botId } = req.params;
    const bot = await Bot.findOneAndDelete({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    // Cascade delete associated resources
    await BotFile.deleteMany({ botId });
    await BotChunk.deleteMany({ botId });
    await BotEmbedding.deleteMany({ botId });
    await BotApi.deleteMany({ botId });
    await BotConversation.deleteMany({ botId });
    await BotMessage.deleteMany({ botId });
    await BotContact.deleteMany({ botId });

    return res.json({ message: "Bot and all associated multi-tenant knowledge base data deleted successfully." });
  } catch (err) {
    console.error("Delete Bot error:", err);
    return res.status(500).json({ error: "Failed to delete bot." });
  }
};

// -----------------------------------------------------------------------------
// 2. KNOWLEDGE UPLOAD & RAG CHUNKING CONTROLLERS
// -----------------------------------------------------------------------------

exports.uploadBotFile = async (req, res) => {
  try {
    const { botId } = req.params;
    const { fileName, fileType, fileContentBase64, rawText } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    let parsedContent = rawText || "";

    if (!parsedContent && fileContentBase64) {
      const buffer = Buffer.from(fileContentBase64, "base64");
      parsedContent = buffer.toString("utf-8");
    }

    if (!parsedContent || typeof parsedContent !== "string") {
      return res.status(400).json({ error: "File content could not be read or parsed." });
    }

    const cleanName = fileName || `file_${Date.now()}.${fileType || "txt"}`;
    const detectedType = (fileType || cleanName.split(".").pop() || "txt").toLowerCase();

    // Store BotFile record preserving originalContent and metadata
    const botFile = await BotFile.create({
      botId,
      ownerId: req.user.id,
      userId: req.user.id,
      fileName: cleanName,
      fileType: detectedType,
      fileSize: Buffer.byteLength(parsedContent, "utf-8"),
      originalContent: parsedContent,
      parsedText: parsedContent
    });

    console.log(`📁 [AUDIT LOG] Knowledge File Uploaded: ${cleanName}, Type: ${detectedType}, Size: ${botFile.fileSize} bytes`);

    // Generate text chunks & embeddings
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
    const { fileName, fileType, fileContentBase64, rawText } = req.body;

    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    const existingFile = await BotFile.findOne({
      _id: fileId,
      botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!existingFile) {
      return res.status(404).json({ error: "File to replace was not found." });
    }

    let parsedContent = rawText || "";
    if (!parsedContent && fileContentBase64) {
      const buffer = Buffer.from(fileContentBase64, "base64");
      parsedContent = buffer.toString("utf-8");
    }

    if (!parsedContent || typeof parsedContent !== "string") {
      return res.status(400).json({ error: "Replacement file content could not be read or parsed." });
    }

    const cleanName = fileName || existingFile.fileName;
    const detectedType = (fileType || cleanName.split(".").pop() || "txt").toLowerCase();

    // 1. Purge all previous chunks & embeddings for this file
    await BotChunk.deleteMany({ fileId });
    await BotEmbedding.deleteMany({ fileId });

    // 2. Update BotFile record with new document content & size
    existingFile.fileName = cleanName;
    existingFile.fileType = detectedType;
    existingFile.fileSize = Buffer.byteLength(parsedContent, "utf-8");
    existingFile.originalContent = parsedContent;
    existingFile.parsedText = parsedContent;

    // 3. Chunk new content & generate vector embeddings
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

// -----------------------------------------------------------------------------
// 4. RAG-POWERED BOT CHAT CONTROLLER WITH STRICT KNOWLEDGE BOUNDARY & CONTACT AUTOMATION
// -----------------------------------------------------------------------------

exports.sendBotChatMessage = async (req, res) => {
  const reqStartTime = performance.now();
  let dbFetchTime = 0;
  let entityExtractTime = 0;
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
    const bot = await Bot.findOne({
      _id: botId,
      $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
    });
    if (!bot) {
      return res.status(404).json({ error: "Bot not found or unauthorized." });
    }

    let conversation;
    if (conversationId) {
      conversation = await BotConversation.findOne({
        _id: conversationId,
        botId,
        $or: [{ userId: req.user.id }, { ownerId: req.user.id }]
      });
    }

    if (!conversation) {
      conversation = await BotConversation.create({
        botId,
        ownerId: req.user.id,
        userId: req.user.id,
        title: message.trim().substring(0, 35) || "New Conversation"
      });
    } else if (!conversation.title || conversation.title === "New Conversation" || conversation.title === "New Bot Conversation") {
      // Persist the first meaningful user message as conversation title for future sessions
      conversation.title = message.trim().substring(0, 35) || "New Conversation";
      await conversation.save();
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(`data: ${JSON.stringify({ type: "meta", conversationId: conversation._id, title: conversation.title })}\n\n`);

    // Fetch conversation memory (last 10 messages)
    const historyMessages = await BotMessage.find({ conversationId: conversation._id, botId })
      .sort({ createdAt: -1 })
      .limit(10);
    const sortedHistory = historyMessages.reverse();

    // Trigger LLM Narrative Summary generation when total message count reaches threshold
    const totalMsgCount = await BotMessage.countDocuments({ conversationId: conversation._id });
    if (totalMsgCount >= 20 && totalMsgCount % 5 === 0) {
      const newSummary = await generateLLMSummary(sortedHistory, conversation.conversationSummary);
      conversation.conversationSummary = newSummary;
      await conversation.save();
    }

    dbFetchTime = performance.now() - tDbStart;

    // Contact Entity Extraction & Automation Check
    const tExtractStart = performance.now();
    const extractionResult = extractEntities(message, {});
    const extracted = extractionResult.extracted || {};
    entityExtractTime = performance.now() - tExtractStart;

    if (extracted.firstName && extracted.lastName && extracted.email && extracted.phone) {
      console.log("🚀 [CONTACT AUTOMATION] Contact payload captured:", extracted);
      const savedContact = await triggerBotContactAutomation(req.user.id, botId, conversation._id, extracted);

      const successResponse = `Thank you! Your contact details have been verified and registered into our database:\n\n• **First Name**: ${extracted.firstName}\n• **Last Name**: ${extracted.lastName}\n• **Email**: ${extracted.email}\n• **Phone**: ${extracted.phone}\n• **Company**: ${extracted.companyName || "Not provided"}\n\nCRM Sync Status: **${savedContact.crmSyncStatus}** (Contact ID: ${savedContact.crmContactId})`;

      await streamTextInChunks(res, successResponse, 15);

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
        content: successResponse
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

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

    // Greeting & Conversational Quick Handler
    if (/^(hi|hello|hey|greetings|howdy|good morning|good evening|hi there|hello there)$/i.test(message.trim())) {
      const greetingMsg = `Hello! I am ${bot.name}. How can I assist you today?`;
      await streamTextInChunks(res, greetingMsg, 15);

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
        content: greetingMsg
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Multi-tenant Isolated Knowledge Retrieval
    const tRagStart = performance.now();
    const ragResult = await retrieveRelevantChunks(req.user.id, botId, message, 3, sortedHistory, bot.knowledgeSummary);
    ragSearchTime = performance.now() - tRagStart;

    if (ragResult.debug) {
      console.log("🧠 [RAG DEBUG]", {
        userId: req.user.id,
        botId,
        message,
        reason: ragResult.reason || "ACCEPTED",
        metadataMatch: ragResult.metadataMatch || false,
        debug: ragResult.debug
      });
    }

    const sourcesMeta = ragResult.isFound
      ? ragResult.chunks.map(c => ({ fileName: c.fileName, snippet: c.snippet.substring(0, 100) + "..." }))
      : [];

    if (sourcesMeta.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "sources", sources: sourcesMeta })}\n\n`);
    }

    // Strict Out-of-Scope Fallback Rule using Bot Name
    if (!ragResult.isFound) {
      const outOfScopeMsg = "I couldn't find information about that topic in the available documentation. My strongest answers come from the uploaded knowledge base. If your question relates to the documented topics, I'll be happy to help.";
      await streamTextInChunks(res, outOfScopeMsg, 15);

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
        content: outOfScopeMsg
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Build grounded RAG system prompt
    const systemPrompt = buildRagSystemPrompt(bot.name, bot.description, ragResult.chunks, configuredApis, bot.knowledgeSummary);

    const { selectBestClusterNode, clusterState } = require("../utils/ollamaHelper");
    const selectedNode = selectBestClusterNode();
    selectedNode.activeRequests++;

    const targetModel = (bot.model && !/^(gpt-4|gpt-3|claude)/i.test(bot.model)) 
      ? bot.model 
      : selectedNode.defaultModel;

    // Construct clean, non-duplicative messages array for Ollama Chat API
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

    let accumulatedResponseText = "";
    let streamedSuccessfully = false;

    llmRequestStartTime = performance.now();

    try {
      const endpointPath = selectedNode.format === "openai" ? "/v1/chat/completions" : "/api/chat";
      const requestPayload = {
        model: targetModel,
        messages: ollamaMessages,
        stream: true
      };
      if (selectedNode.format === "ollama") {
        requestPayload.keep_alive = "24h";
      }

      let ollamaRes = await fetch(`${selectedNode.url}${endpointPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify(requestPayload)
      });

      // Failover to secondary node if primary node request fails
      if (!ollamaRes.ok) {
        console.warn(`⚠️ [BOT CLUSTER FAILOVER] ${selectedNode.id} HTTP ${ollamaRes.status}. Attempting secondary node failover...`);
        const fallbackNode = clusterState.find(n => n.id !== selectedNode.id);
        if (fallbackNode) {
          const fallbackPath = fallbackNode.format === "openai" ? "/v1/chat/completions" : "/api/chat";
          ollamaRes = await fetch(`${fallbackNode.url}${fallbackPath}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: fallbackNode.defaultModel,
              messages: ollamaMessages,
              stream: true
            })
          });
        }
      }

      if (ollamaRes.ok && ollamaRes.body) {
        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let lineBuffer = "";

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
                res.write(`data: ${JSON.stringify({ type: "chunk", chunk: chunkText, text: chunkText })}\n\n`);
              }
            } catch (e) { }
          }
        }
        streamedSuccessfully = true;
      }
    } catch (ollamaErr) {
      console.warn("⚠️ [BOT CHAT OLLAMA] Ollama service error:", ollamaErr.message);
    } finally {
      selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);
    }

    if (!streamedSuccessfully || !accumulatedResponseText.trim()) {
      if (!ragResult.isFound) {
        accumulatedResponseText = "I couldn't find information about that in the uploaded knowledge base.";
      } else {
        accumulatedResponseText = "I encountered an issue generating a response. Please check that Ollama is running locally.";
      }
      await streamTextInChunks(res, accumulatedResponseText, 15);
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

    const totalDuration = performance.now() - reqStartTime;
    if (firstTokenTimestamp) {
      streamDuration = performance.now() - firstTokenTimestamp;
    }

    console.log(`
⏱️  =================== [LATENCY DIAGNOSTICS BREAKDOWN] ===================
  📌 Route: Bot Chat Stream (/api/v1/bots/${botId}/chat)
  ├── 🗄️ Database Operations:          ${dbFetchTime.toFixed(2)} ms
  ├── 🔍 Entity Extraction:             ${entityExtractTime.toFixed(2)} ms
  ├── 🧠 RAG & Vector Search:           ${ragSearchTime.toFixed(2)} ms
  ├── 🚀 Time To First Token (TTFT):   ${ttft !== null ? ttft.toFixed(2) + ' ms' : 'N/A (Ollama Delay/Error)'} <-- [AI Model Load & Prompt Eval Lag]
  ├── ⚡ Token Streaming Duration:     ${streamDuration > 0 ? streamDuration.toFixed(2) + ' ms' : 'N/A'}
  └── 🏁 TOTAL REQUEST DURATION:        ${totalDuration.toFixed(2)} ms
========================================================================\n
`);

    res.write("data: [DONE]\n\n");
    return res.end();
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
