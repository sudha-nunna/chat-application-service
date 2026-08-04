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
    res.write(`event: chunk\ndata: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * Generic multi-agent contact & lead capture automation.
 * If a custom BotApi is attached to this bot, dispatches payload directly to the custom API endpoint.
 * Otherwise, persists the contact record locally into BotContact database.
 */
async function triggerBotContactAutomation(userId, botId, conversationId, contactDetails) {
  // Check if bot has a user-configured custom API integration
  const botApis = await BotApi.find({ botId, $or: [{ userId }, { ownerId: userId }] });
  const postApi = botApis.find(a => a.method === "POST") || botApis[0];

  let crmContactId = `lead_${Date.now()}`;
  let crmSyncStatus = "SUCCESS";

  if (postApi && postApi.url) {
    const headers = { "Content-Type": "application/json" };
    if (postApi.authType === "apiKey" && postApi.encryptedApiKey) {
      headers["x-api-key"] = decrypt(postApi.encryptedApiKey);
    } else if (postApi.authType === "bearerToken" && postApi.encryptedBearerToken) {
      headers["Authorization"] = `Bearer ${decrypt(postApi.encryptedBearerToken)}`;
    }

    try {
      const response = await fetch(postApi.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          firstName: contactDetails.firstName,
          lastName: contactDetails.lastName,
          email: contactDetails.email,
          phone: contactDetails.phone,
          companyName: contactDetails.companyName || "N/A"
        })
      });

      if (response.ok) {
        const resData = await response.json();
        crmContactId = resData.contactId || resData.id || `lead_${Date.now()}`;
      }
    } catch (err) {
      console.warn("⚠️ Custom Bot API Dispatch Notice (recording locally):", err.message);
    }
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
    const { name, description, model, botMode, allowedDomains, systemPrompt, initialApis, stagedFiles } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Bot name is required." });
    }

    const uploadedFiles = Array.isArray(stagedFiles) ? stagedFiles : [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: "Please upload at least one knowledge file before creating the bot." });
    }

    // Determine botMode: small, medium, or large
    const effectiveBotMode = (botMode || model || "medium").toLowerCase();
    const finalBotMode = ["small", "medium", "large"].includes(effectiveBotMode) ? effectiveBotMode : "medium";
    const finalModel = (model && !["small", "medium", "large"].includes(model.toLowerCase())) ? model : "gpt-4o";
    const domainsList = Array.isArray(allowedDomains) ? allowedDomains.map(d => String(d).trim().toLowerCase()).filter(Boolean) : [];

    const bot = await Bot.create({
      ownerId: req.user.id,
      userId: req.user.id,
      name: name.trim(),
      description: description ? description.trim() : "",
      model: finalModel,
      botMode: finalBotMode,
      allowedDomains: domainsList,
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
    const { name, description, model, botMode, allowedDomains, systemPrompt } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (systemPrompt !== undefined) updateData.systemPrompt = systemPrompt;

    if (Array.isArray(allowedDomains)) {
      updateData.allowedDomains = allowedDomains.map(d => String(d).trim().toLowerCase()).filter(Boolean);
    }

    if (botMode) {
      updateData.botMode = ["small", "medium", "large"].includes(botMode.toLowerCase()) ? botMode.toLowerCase() : "medium";
    }
    if (model) {
      if (["small", "medium", "large"].includes(model.toLowerCase())) {
        updateData.botMode = model.toLowerCase();
      } else {
        updateData.model = model;
      }
    }

    const bot = await Bot.findOneAndUpdate(
      { _id: botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] },
      updateData,
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
 * Helper to parse markdown text into structured UI Component payload:
 * Components supported: "table" | "list" | "card" | "text"
 */
function parseStructuredUI(text) {
  if (!text || typeof text !== "string") {
    return { component: "text", title: "Response", data: { text: "" } };
  }

  const trimmed = text.trim();

  // 1. Table Detection (| Col1 | Col2 |)
  const tableRegex = /\|(.+)\|[\r\n]+\|[-:\s|]+\|[\r\n]+((?:\|.+\|[\r\n]*)+)/;
  const tableMatch = trimmed.match(tableRegex);

  if (tableMatch) {
    const rawHeaders = tableMatch[1].split("|").map(h => h.trim()).filter(Boolean);
    const rawRows = tableMatch[2]
      .trim()
      .split(/\r?\n/)
      .filter(line => line.includes("|") && !/^\|?\s*[-:\s|]+\s*\|?$/.test(line))
      .map(row => {
        const cells = row.split("|").map(cell => cell.trim());
        // Handle optional leading/trailing pipe empty cells
        if (cells.length > 2 && cells[0] === "" && cells[cells.length - 1] === "") {
          return cells.slice(1, -1);
        }
        return cells.filter(Boolean);
      })
      .filter(row => row.length > 0);

    return {
      component: "table",
      title: "Structured Data Table",
      data: {
        headers: rawHeaders,
        rows: rawRows,
        rawMarkdown: text
      }
    };
  }

  // 2. List Detection (- Item or 1. Item)
  const listItems = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map(line => line.replace(/^([-*•]|\d+\.)\s+/, "").trim());

  if (listItems.length >= 2) {
    return {
      component: "list",
      title: "List Items",
      data: {
        items: listItems,
        rawMarkdown: text
      }
    };
  }

  // 3. Card Detection (Structured text snippet)
  if (trimmed.length > 40) {
    return {
      component: "card",
      title: "Summary Card",
      data: {
        text: trimmed,
        highlights: listItems
      }
    };
  }

  // 4. Default Text Component
  return {
    component: "text",
    title: "Text Message",
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
    responseType: structuredUI.component,
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

    // Detect response format requested by client:
    // Mode A: SSE Streaming ("text/event-stream" or req.body.stream === true)
    // Mode B: Structured JSON ("application/json" or req.body.stream === false or req.body.format === "json")
    const acceptHeader = (req.headers.accept || "").toLowerCase();
    const isStreamRequested = (req.body.stream === true) || acceptHeader.includes("text/event-stream") || (req.body.stream !== false && !acceptHeader.includes("application/json"));

    if (isStreamRequested) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: metadata\ndata: ${JSON.stringify({ type: "meta", responseType: "text", title: conversation.title || "Bot Conversation", conversationId: conversation._id, chatId: conversation._id })}\n\n`);
    }

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
    // Intent classification via Smart Intent Router
    const intent = detectBotIntent(message, bot.knowledgeSummary);

    if (intent === "GREETING") {
      const botName = bot.name || "AI Assistant";
      const greetingMsg = `Hello! I'm ${botName}. How can I assist you today? Feel free to ask general questions or inquiries related to our documentation and connected APIs.`;
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

    // Extract bot mode: small (Strict Document Only), medium (Balanced Hybrid), large (Omni AI)
    const rawBotMode = (bot.botMode || bot.model || "medium").toLowerCase();
    const currentBotMode = ["small", "medium", "large"].includes(rawBotMode) ? rawBotMode : "medium";

    let isGeneralQuery = (intent === "GENERAL_QUERY" || intent === "GENERAL_CONVERSATION" || intent === "GREETING");

    // In SMALL Mode (Strict Knowledge Bot), non-greeting queries force document RAG search
    if (currentBotMode === "small" && intent !== "GREETING") {
      isGeneralQuery = false;
    }

    let ragResult = { isFound: true, chunks: [] };

    // Check if bot has uploaded document files
    const hasFilesCount = await BotFile.countDocuments({ botId, $or: [{ userId: req.user.id }, { ownerId: req.user.id }] });
    const hasUploadedFiles = hasFilesCount > 0;

    if (!isGeneralQuery && hasUploadedFiles) {
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
  ${isGeneralQuery
        ? `⚡ RAG Decision:        [BYPASSED] General Conversation Mode (0ms DB Overhead)`
        : `📄 RAG Decision:        [EXECUTED] Document Grounding Search (${ragSearchTime.toFixed(2)} ms | Chunks: ${ragResult.chunks?.length || 0})`}
  🧠 System Prompt:       ${isGeneralQuery ? `buildGeneralSystemPrompt (${currentBotMode.toUpperCase()})` : "buildRagSystemPrompt (Strict Grounding + Sources)"}
========================================================================\n`);

    if (sourcesMeta.length > 0 && isStreamRequested) {
      res.write(`event: sources\ndata: ${JSON.stringify({ type: "sources", sources: sourcesMeta })}\n\n`);
    }

    // Strict Out-of-Scope Fallback Rule based on botMode when no chunks match
    if (!isGeneralQuery && hasUploadedFiles && !ragResult.isFound) {
      let outOfScopeMsg;
      if (currentBotMode === "small") {
        outOfScopeMsg = "I am configured in Strict Document Mode (Small) and can only answer questions directly covered by the uploaded documentation. I couldn't find information about that topic in the available files.";
      } else if (currentBotMode === "medium") {
        outOfScopeMsg = "I couldn't find specific details on that topic in the uploaded documentation. My strongest answers come from the available knowledge base. Please ask questions related to the documented topics.";
      } else {
        outOfScopeMsg = "I couldn't find information about that topic in the available documentation. I'll be happy to assist you using general knowledge if you'd like!";
      }

      const { extractExtractedTopics } = require("../utils/ragEngine");
      const topTopics = extractExtractedTopics(bot);
      const featuredTopic = topTopics[0] || "Our Knowledge Base";
      const cardTitle = `Did You Know: ${featuredTopic}`;

      // Emit special card & schedule_call metadata for FE team to render interactive Card UI!
      if (isStreamRequested) {
        res.write(`event: metadata\ndata: ${JSON.stringify({
          type: "card",
          responseType: "card",
          title: cardTitle,
          action: "SCHEDULE_CALL",
          message: outOfScopeMsg,
          conversationId: conversation._id,
          botMode: currentBotMode,
          topics: topTopics
        })}\n\n`);

        await streamTextInChunks(res, outOfScopeMsg, 15);
      } else {
        return res.json({
          response: outOfScopeMsg,
          type: "card",
          responseType: "card",
          conversationId: conversation._id,
          structuredUI: {
            type: "card",
            responseType: "card",
            title: cardTitle,
            action: "SCHEDULE_CALL",
            message: outOfScopeMsg,
            conversationId: conversation._id,
            botMode: currentBotMode,
            topics: topTopics
          }
        });
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
        content: outOfScopeMsg
      });

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Build system prompt based on adaptive intent and currentBotMode
    const { buildGeneralSystemPrompt } = require("../utils/ragEngine");
    let systemPrompt;
    if (isGeneralQuery) {
      systemPrompt = buildGeneralSystemPrompt(bot.name, bot.description, currentBotMode);
    } else {
      systemPrompt = buildRagSystemPrompt(bot.name, bot.description, ragResult.chunks, configuredApis, bot.knowledgeSummary);
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

    const totalDuration = performance.now() - reqStartTime;
    if (firstTokenTimestamp) {
      streamDuration = performance.now() - firstTokenTimestamp;
    }

    console.log(`
⏱️  =================== [LATENCY DIAGNOSTICS BREAKDOWN] ===================
  📌 Route: Bot Chat ${isStreamRequested ? 'Stream (SSE)' : 'REST (JSON)'} (/api/v1/bots/${botId}/chat)
  ├── 🗄️ Database Operations:          ${dbFetchTime.toFixed(2)} ms
  ├── 🔍 Entity Extraction:             ${entityExtractTime.toFixed(2)} ms
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

    return res.status(201).json({
      success: true,
      message: "Bot API Key and Secret Key generated successfully.",
      botId: bot._id,
      botName: bot.name,
      apiKey: bot.apiKey,
      secretKey: bot.secretKey,
      keyCreatedAt: bot.keyCreatedAt
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

    if (!bot.apiKey || !bot.secretKey) {
      return res.json({
        success: true,
        hasKeys: false,
        message: "No API Key or Secret Key has been generated for this bot yet."
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
      keyLastUsedAt: bot.keyLastUsedAt
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
    const { message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, message: "Validation error: 'message' payload is required and must be a non-empty string." });
    }

    if (message.trim().length > 4000) {
      return res.status(400).json({ success: false, message: "Validation error: 'message' payload exceeds maximum limit of 4000 characters." });
    }

    // Pass botId & owner user context
    req.params.botId = bot._id.toString();
    req.user = { id: (bot.ownerId || bot.userId).toString() };

    return exports.sendBotChatMessage(req, res);
  } catch (err) {
    console.error("External Bot Chat Error:", err);
    return res.status(500).json({ success: false, message: "Failed to process external bot chat message.", error: err.message });
  }
};
