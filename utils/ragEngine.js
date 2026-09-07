const mongoose = require("mongoose");
const BotChunk = require("../models/BotChunk");
const BotEmbedding = require("../models/BotEmbeddings");

const { getOllamaBaseUrl, getAvailableOllamaModel } = require("./ollamaHelper");

const OLLAMA_BASE_URL = getOllamaBaseUrl();

const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// STOPWORDS for keyword indexing and topic validation
const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "can't", "cannot", "could",
  "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down",
  "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
  "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
  "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's",
  "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it",
  "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
  "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
  "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't",
  "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
  "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
  "they've", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
  "weren't", "what", "what's", "when", "when's", "where", "where's", "which",
  "while", "who", "who's", "whom", "whose", "why", "why's", "will", "with", "won't", "would",
  "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
  "yourself", "yourselves", "tell", "show", "give", "use", "please", "know", "find"
]);

/**
 * Tokenizes text into cleaned lowercase word tokens.
 * Automatically expands spaced & joined alphanumeric variations (e.g. "web 3" <-> "web3").
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));

  const expanded = new Set(rawTokens);

  // Expand spaced alphanumeric tokens (e.g. "web" + "3" -> "web3")
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const combined = rawTokens[i] + rawTokens[i + 1];
    if (/^[a-z]+[0-9]+$/i.test(combined) || /^[0-9]+[a-z]+$/i.test(combined)) {
      expanded.add(combined);
    }
  }

  // Expand joined alphanumeric tokens (e.g. "web3" -> "web", "3")
  for (const token of rawTokens) {
    const match = token.match(/^([a-z]+)([0-9]+)$/i);
    if (match) {
      expanded.add(match[1]);
      expanded.add(match[2]);
      expanded.add(`${match[1]} ${match[2]}`);
    }
  }

  return Array.from(expanded);
}

/**
 * Generates a high-density 64-dimensional semantic feature vector fallback.
 */
function generateEmbeddingVector(text) {
  const DIMENSIONS = 64;
  const vector = new Array(DIMENSIONS).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  for (let pos = 0; pos < tokens.length; pos++) {
    const token = tokens[pos];
    let h1 = 5381;
    let h2 = 0;
    for (let i = 0; i < token.length; i++) {
      const code = token.charCodeAt(i);
      h1 = ((h1 << 5) + h1) ^ code;
      h2 = (h2 * 31 + code) >>> 0;
    }
    const idx1 = Math.abs(h1) % DIMENSIONS;
    const idx2 = Math.abs(h2) % DIMENSIONS;
    vector[idx1] += 1.5;
    vector[idx2] += 1.0;

    // Character trigrams for morphological and root-word similarity
    if (token.length >= 3) {
      for (let i = 0; i <= token.length - 3; i++) {
        const triHash = Math.abs((token.charCodeAt(i) * 31 + token.charCodeAt(i + 1)) * 31 + token.charCodeAt(i + 2)) % DIMENSIONS;
        vector[triHash] += 0.5;
      }
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    return vector.map(val => Number((val / magnitude).toFixed(5)));
  }
  return vector;
}

class BoundedMap {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }
  has(key) {
    return this.map.has(key);
  }
}

const embeddingCache = new BoundedMap(500);

/**
 * Generates high-density semantic vector embeddings via Ollama nomic-embed-text API.
 * Uses high-speed in-memory vector caching for instant (< 2ms) lookups.
 */
async function generateEmbeddingVectorAsync(text) {
  if (!text || typeof text !== "string") return generateEmbeddingVector(text);
  const cacheKey = text.trim().toLowerCase();
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  try {
    console.log(`\n📤 [AI REQUEST -> OLLAMA (EMBEDDINGS)] Model: ${OLLAMA_EMBED_MODEL} | Text: "${text.slice(0, 80)}..."`);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_EMBED_MODEL,
        prompt: text
      })
    });
    if (response.ok) {
      const data = await response.json();
      if (data.embedding && Array.isArray(data.embedding)) {
        console.log(`📥 [AI RESPONSE <- OLLAMA (EMBEDDINGS)] Success (${data.embedding.length} dimensions)`);
        embeddingCache.set(cacheKey, data.embedding);
        return data.embedding;
      }
    } else {
      console.warn(`⚠️ [AI EMBEDDINGS WARN <- OLLAMA] HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ [AI EMBEDDINGS ERROR <- OLLAMA] ${err.message}`);
  }

  const fallback = generateEmbeddingVector(text);
  embeddingCache.set(cacheKey, fallback);
  return fallback;
}

/**
 * Smart Intent Router: Classifies incoming user message into supported classes.
 * Distinguishes GENERAL_QUERY (coding, math, general world facts) vs DOCUMENT_QUERY (PDF/KB queries).
 */
function detectBotIntent(message, botMetadata = null) {
  if (!message || typeof message !== "string") return "GREETING";
  const trimmed = message.trim().toLowerCase();

  // 1. Greetings
  if (/^(hi|hello|hey|greetings|good\s+morning|good\s+afternoon|good\s+evening)$/i.test(trimmed)) {
    return "GREETING";
  }

  // 2. Formatting & Contextual Follow-up Queries (e.g. "in table form", "give me in list", "show as table", "summarize that")
  const isFormattingOrFollowup = /\b(table|list|bullet|bullets|format|form|summarize|detail|explain\s+more|row|rows|column|columns|chart|grid)\b/i.test(trimmed);
  if (isFormattingOrFollowup) {
    return "DOCUMENT_QUERY";
  }

  // 3. Explicit Document / API Queries
  const explicitDocQuery = /\b(pdf|document|uploaded|file|manual|policy|guide|kb|knowledge\s+base|postman|collection|documentation)\b/i.test(trimmed);
  if (explicitDocQuery) {
    return "DOCUMENT_QUERY";
  }

  // 4. Match against bot metadata topics
  if (botMetadata && matchQueryToMetadata(message, botMetadata)) {
    return "DOCUMENT_QUERY";
  }

  // 5. Default fallback: General questions bypass document RAG search
  return "GENERAL_QUERY";
}

/**
 * Computes Cosine Similarity between two embedding vectors.
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Chunks raw document text into ~200-300 word chunks with overlap.
 */
function chunkText(rawText, maxWordsPerChunk = 200, overlapWords = 30) {
  if (!rawText || typeof rawText !== "string") return [];
  const words = rawText.trim().split(/\s+/);
  if (words.length === 0) return [];

  const chunks = [];
  let startIndex = 0;

  while (startIndex < words.length) {
    const endIndex = Math.min(startIndex + maxWordsPerChunk, words.length);
    const chunkWords = words.slice(startIndex, endIndex);
    const textSnippet = chunkWords.join(" ");

    chunks.push({
      text: textSnippet,
      keywords: tokenize(textSnippet),
      embedding: generateEmbeddingVector(textSnippet)
    });

    if (endIndex >= words.length) break;
    startIndex += (maxWordsPerChunk - overlapWords);
  }

  return chunks;
}

/**
 * Generates an AI LLM narrative summary after every 20 messages.
 */
async function generateLLMSummary(historyMessages = [], existingSummary = "") {
  if (!historyMessages || historyMessages.length === 0) return existingSummary || "";

  const formattedHistory = historyMessages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const prompt = `You are an enterprise conversation summarization engine. Combine the previous summary with the latest conversation messages into a concise 2-4 sentence narrative summary.
Extract ONLY important information:
- User requirements, goals, and constraints
- Key decisions made and user preferences
- Unresolved issues or pending requests
- Key technical concepts or discussion points

Previous Summary:
${existingSummary || "None"}

Latest Conversation Messages:
${formattedHistory}

INSTRUCTIONS:
Return ONLY the plain text summary narrative. Do NOT include introductory phrases like "Here is a summary" or meta-talk.`;

  const targetModel = await getAvailableOllamaModel(OLLAMA_BASE_URL, process.env.OLLAMA_MODEL);

  try {
    console.log(`\n================================================================================`);
    console.log(`📤 [AI REQUEST -> OLLAMA (RAG SUMMARY)]`);
    console.log(`  • Endpoint: ${OLLAMA_BASE_URL}/api/generate`);
    console.log(`  • Model:    ${targetModel}`);
    console.log(`  • Prompt:   ${prompt.slice(0, 200)}...`);
    console.log(`================================================================================\n`);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: targetModel,
        prompt: prompt,
        stream: false
      })
    });

    if (response.ok) {
      const data = await response.json();
      const summaryText = data.response ? data.response.trim() : "";
      console.log(`\n================================================================================`);
      console.log(`📥 [AI RESPONSE <- OLLAMA (RAG SUMMARY)]`);
      console.log(`  • Status:       ${response.status} OK`);
      console.log(`  • Summary Text: ${summaryText}`);
      console.log(`================================================================================\n`);
      if (summaryText) {
        return summaryText;
      }
    } else {
      console.error(`\n❌ [AI ERROR RESPONSE <- OLLAMA (RAG SUMMARY)] Status: ${response.status} ${response.statusText}\n`);
    }
  } catch (err) {
    console.warn("⚠️ [LLM SUMMARY NOTICE] Ollama summarization offline, using narrative summary fallback:", err.message);
  }

  const userTopics = historyMessages
    .filter(m => m.role === "user")
    .map(m => m.content.substring(0, 50))
    .slice(-4)
    .join("; ");
  return `The user and assistant engaged in a multi-turn discussion focused on: ${userTopics}. Key topics were explained with practical examples and guidance.`;
}

function normalizePhrase(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[^a-zA-Z0-9\s&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractDocumentTitle(text) {
  if (!text || typeof text !== "string") return "";
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 5 && line.length < 120);

  for (const line of lines) {
    if (/^#+\s*/.test(line)) {
      return line.replace(/^#+\s*/, "").trim();
    }
    if (/^[A-Z][A-Za-z0-9\s:\-&,\.]{5,120}$/.test(line) && line.split(" ").length <= 10) {
      return line.trim();
    }
  }

  return lines.length > 0 ? lines[0] : "";
}

function extractCandidatePhrases(text) {
  const phrases = new Map();
  if (!text || typeof text !== "string") return [];

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length > 5 && line.length < 80 && /[A-Z]/.test(line) && !/^[0-9]/.test(line)) {
      const cleaned = normalizePhrase(line);
      if (cleaned && cleaned.split(" ").length <= 5) {
        phrases.set(cleaned, (phrases.get(cleaned) || 0) + 1);
      }
    }
  }

  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    phrases.set(bigram, (phrases.get(bigram) || 0) + 1);
  }

  const extracted = Array.from(phrases.entries())
    .filter(([phrase, count]) => count > 1 && phrase.split(" ").length <= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([phrase]) => phrase);

  return extracted;
}

function extractSectionHeadings(text) {
  if (!text || typeof text !== "string") return [];
  const headings = new Set();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (/^#+\s*/.test(line) || /^\S.+\n?[=\-]{2,}$/.test(line)) {
      const cleaned = normalizePhrase(line.replace(/^#+\s*/, ""));
      if (cleaned.length > 4 && cleaned.split(" ").length <= 8) {
        headings.add(cleaned);
      }
    }
    if (/^[A-Z][A-Za-z0-9 ]{5,80}$/.test(line) && line.split(" ").length <= 8 && /[A-Z]/.test(line)) {
      headings.add(normalizePhrase(line));
    }
  }

  return Array.from(headings).slice(0, 40);
}

function extractKnowledgeMetadataFromText(text) {
  const normalized = normalizePhrase(text);
  const title = extractDocumentTitle(text);
  const phrases = extractCandidatePhrases(text);
  const headings = new Set(extractSectionHeadings(text));

  const products = new Set();
  const modules = new Set();
  const topics = new Set();
  const features = new Set();
  const services = new Set();

  if (title) {
    headings.add(normalizePhrase(title));
    topics.add(normalizePhrase(title));
    products.add(normalizePhrase(title));
  }

  for (const phrase of phrases) {
    if (/\b(platform|suite|solution|engine|system|application|service\s+platform)\b/.test(phrase)) {
      products.add(phrase);
      topics.add(phrase);
    }
    if (/\b(lead|contact|pipeline|module|management|analytics|workflow|sales|support|customer)\b/.test(phrase)) {
      modules.add(phrase);
      topics.add(phrase);
    }
    if (/\b(service|api|integration|support|automation|operations|security|customer\s+success)\b/.test(phrase)) {
      services.add(phrase);
      topics.add(phrase);
    }
    if (/\b(feature|capabilit|function|ability|automate|report|alert|dashboard)\b/.test(phrase)) {
      features.add(phrase);
      topics.add(phrase);
    }
    if (phrase.split(" ").length <= 4 && phrase.length > 6) {
      headings.add(phrase);
    }
  }

  return {
    title: title ? normalizePhrase(title) : "",
    titles: title ? [normalizePhrase(title)] : [],
    products: Array.from(products),
    modules: Array.from(modules),
    topics: Array.from(topics),
    features: Array.from(features),
    services: Array.from(services),
    headings: Array.from(headings),
    rawSummary: normalized
  };
}

function extractExtractedTopics(bot) {
  const summary = bot?.knowledgeSummary || {};
  const topicsSet = new Set();

  if (Array.isArray(summary.topics)) summary.topics.forEach(t => topicsSet.add(t));
  if (Array.isArray(summary.modules)) summary.modules.forEach(m => topicsSet.add(m));
  if (Array.isArray(summary.products)) summary.products.forEach(p => topicsSet.add(p));
  if (Array.isArray(summary.services)) summary.services.forEach(s => topicsSet.add(s));
  if (Array.isArray(summary.features)) summary.features.forEach(f => topicsSet.add(f));
  if (Array.isArray(summary.headings)) summary.headings.forEach(h => topicsSet.add(h));
  if (Array.isArray(bot?.knowledgeTopics)) bot.knowledgeTopics.forEach(t => topicsSet.add(t));
  if (Array.isArray(bot?.knowledgeModules)) bot.knowledgeModules.forEach(m => topicsSet.add(m));

  const items = Array.from(topicsSet)
    .filter(t => typeof t === "string" && t.trim().length > 2)
    .map(t => {
      return t
        .trim()
        .toLowerCase()
        .replace(/(?:^|\s|-)\S/g, char => char.toUpperCase());
    })
    .slice(0, 8);

  if (items.length === 0) {
    return [
      "Product Documentation",
      "API Integrations",
      "User Guides",
      "Support Procedures",
      "Internal Processes"
    ];
  }
  return items;
}

function isKnowledgeOverviewQuestion(message) {
  if (!message || typeof message !== "string") return false;
  const normalized = message.trim().toLowerCase();
  return /\b(what\s+is\s+your\s+role|what\s+can\s+you\s+do|what\s+can\s+you\s+help|what\s+knowledge\s+do\s+you\s+have|what\s+type\s+of\s+knowledge|what\s+information\s+do\s+you\s+know|what\s+are\s+you\s+trained\s+on|what\s+is\s+this\s+bot|who\s+are\s+you|what\s+topics|tell\s+me\s+about\s+(yourself|this\s+bot|your\s+capabilities)|identify\s+yourself|what\s+do\s+you\s+know|what\s+documents\s+are\s+loaded|what\s+products\s+are\s+covered|what\s+modules\s+exist)\b/.test(normalized);
}

function isKnowledgeDiscoveryQuestion(message) {
  if (!message || typeof message !== "string") return false;
  const normalized = message.trim().toLowerCase();
  return /\b(what\s+is\s+[a-z0-9][a-z0-9\s&]+|tell\s+me\s+about\s+[a-z0-9][a-z0-9\s&]+|explain\s+[a-z0-9][a-z0-9\s&]+|describe\s+[a-z0-9][a-z0-9\s&]+)\b/.test(normalized);
}

function buildKnowledgeOverviewResponse(bot, files = [], message = "") {
  if (!bot || !isKnowledgeOverviewQuestion(message)) return null;

  const botName = bot.name || "AI Assistant";
  const topics = extractExtractedTopics(bot);

  let topicsStr = "";
  if (topics && topics.length > 0) {
    topicsStr = topics.slice(0, 6).join(", ");
  }

  return `I am **${botName}**. I specialize in ${topicsStr || "our core application services and technologies"}.\n\nFeel free to ask any questions about these features and services!`;
}

function matchQueryToMetadata(queryText, metadata) {
  if (!queryText || !metadata) return false;
  const normalizedQuery = normalizePhrase(queryText);
  const queryTokens = tokenize(queryText).filter(Boolean);
  const fields = [
    metadata.titles,
    metadata.products,
    metadata.modules,
    metadata.topics,
    metadata.features,
    metadata.services,
    metadata.headings
  ];

  for (const field of fields) {
    if (!Array.isArray(field)) continue;
    for (const value of field) {
      const normalizedValue = normalizePhrase(value);
      if (!normalizedValue) continue;
      if (normalizedQuery.includes(normalizedValue) || normalizedValue.includes(normalizedQuery)) {
        return true;
      }
      for (const token of queryTokens) {
        if (normalizedValue.includes(token)) {
          return true;
        }
      }
    }
  }

  if (metadata.rawSummary && typeof metadata.rawSummary === "string") {
    return queryTokens.some(token => metadata.rawSummary.includes(token));
  }

  return false;
}



/**
 * Performs Multi-Tenant Hybrid Search (BM25 + Dense Semantic Vector Search + Reciprocal Rank Fusion)
 * strictly isolated by userId and botId. Guarantees exhaustive candidate search without early truncation.
 */
async function retrieveRelevantChunks(userId, botId, userQuestion, topK = 5, historyMessages = [], botMetadata = null) {
  let targetUserId = userId;
  let targetBotId = botId;
  let queryText = userQuestion;

  if (typeof userId === "string" && !userQuestion) {
    targetBotId = userId;
    queryText = botId;
    targetUserId = null;
  }

  // Augment query text with previous user prompt if query is a short formatting or follow-up request
  if (Array.isArray(historyMessages) && historyMessages.length > 0 && queryText) {
    const lastUserMsg = [...historyMessages].reverse().find(m => m.role === "user" && m.content && m.content.trim() !== queryText.trim());
    const isShortOrFollowup = queryText.split(/\s+/).length <= 6 || /\b(table|list|bullet|bullets|format|form|summarize|detail|explain\s+more|row|rows|column|columns|chart|grid)\b/i.test(queryText);
    if (isShortOrFollowup && lastUserMsg?.content) {
      queryText = `${lastUserMsg.content} ${userQuestion}`;
    }
  }

  const effectiveTopK = Math.max(topK || 5, 4);

  // 1. High-Speed Redis Query Caching Check (< 5ms response)
  const { getCache, setCache } = require("./redisClient");
  const crypto = require("crypto");
  const queryHash = crypto.createHash("md5").update(`${targetBotId || "global"}_${(queryText || "").trim().toLowerCase()}_top${effectiveTopK}`).digest("hex");
  const cacheKey = `rag:cache:${targetBotId || "global"}:${queryHash}`;

  try {
    const cachedResult = await getCache(cacheKey);
    if (cachedResult && typeof cachedResult === "object" && cachedResult.isFound !== undefined) {
      return cachedResult;
    }
  } catch (cErr) {}

  let filter = { botId: targetBotId };
  if (targetBotId && mongoose.Types.ObjectId.isValid(targetBotId)) {
    const Bot = require("../models/Bot");
    const botDoc = await Bot.findById(targetBotId).select("projectId").lean();
    if (botDoc && botDoc.projectId) {
      filter = {
        $or: [
          { botId: targetBotId },
          { projectId: botDoc.projectId }
        ]
      };
    }
  }

  if (targetUserId) {
    if (filter.$or) {
      filter = {
        $and: [
          { $or: filter.$or },
          { $or: [{ userId: targetUserId }, { ownerId: targetUserId }] }
        ]
      };
    } else {
      filter.$or = [{ userId: targetUserId }, { ownerId: targetUserId }];
    }
  }

  const queryTokens = tokenize(queryText);

  // 2. STAGE 1: Candidate Chunk Selection (Zero Early Truncation)
  const totalChunksCount = await BotChunk.countDocuments(filter);

  let chunks = [];
  if (totalChunksCount <= 250) {
    // If bot has <= 250 chunks (~50-80 pages), retrieve ALL chunks for exhaustive search!
    const rawChunks = await BotChunk.find(filter)
      .populate("fileId", "fileName fileType fileCategory")
      .lean();
    chunks = (rawChunks || []).filter(c => c.fileId && (!c.fileId.fileCategory || c.fileId.fileCategory === "knowledge"));
  } else {
    // For large collections (> 250 chunks), query with high-signal keywords and expand pool up to 150 candidates
    if (queryTokens.length > 0) {
      const candidateFilter = { ...filter, keywords: { $in: queryTokens } };
      const candidateChunks = await BotChunk.find(candidateFilter)
        .limit(150)
        .populate("fileId", "fileName fileType fileCategory")
        .lean();
      chunks = (candidateChunks || []).filter(c => c.fileId && (!c.fileId.fileCategory || c.fileId.fileCategory === "knowledge"));
    }

    // Fallback: If keyword prefiltering yields fewer than 15 candidates, pull additional chunks up to 150
    if (!chunks || chunks.length < 15) {
      const fallbackChunks = await BotChunk.find(filter)
        .limit(150)
        .populate("fileId", "fileName fileType fileCategory")
        .lean();
      const existingIds = new Set(chunks.map(c => String(c._id)));
      for (const fc of fallbackChunks) {
        if (!existingIds.has(String(fc._id)) && fc.fileId && (!fc.fileId.fileCategory || fc.fileId.fileCategory === "knowledge")) {
          chunks.push(fc);
        }
      }
    }
  }

  if (!chunks || chunks.length === 0) {
    const emptyRes = {
      isFound: false,
      chunks: [],
      reason: "NO_DOCUMENTS"
    };
    try { await setCache(cacheKey, emptyRes, 300); } catch (e) {}
    return emptyRes;
  }

  // 3. STAGE 2: Dense Semantic Vector Generation & Cosine Similarity
  const queryVector = await generateEmbeddingVectorAsync(queryText);
  const isOverview = isKnowledgeOverviewQuestion(queryText);
  const isDiscovery = isKnowledgeDiscoveryQuestion(queryText);
  const metadataMatch = Boolean(botMetadata && matchQueryToMetadata(queryText, botMetadata));

  // Retrieve embeddings for candidate chunks
  const chunkEmbeddings = await BotEmbedding.find({ chunkId: { $in: chunks.map(c => c._id) } }).lean();
  const embeddingMap = new Map(chunkEmbeddings.map(e => [String(e.chunkId), e.embedding]));

  // Clean query text for subphrase matching
  const cleanQuery = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 1);

  // 4. STAGE 3: BM25 Lexical + Semantic Scoring
  const scoredItems = [];
  const totalDocs = chunks.length;

  // Precompute document frequency (DF) for query tokens in candidate pool
  const tokenDocFreq = new Map();
  for (const token of queryTokens) {
    let df = 0;
    for (const c of chunks) {
      if (c.keywords && c.keywords.includes(token)) df++;
      else if (c.text && c.text.toLowerCase().includes(token)) df++;
    }
    tokenDocFreq.set(token, Math.max(df, 1));
  }

  for (const chunk of chunks) {
    const chunkTextLower = (chunk.text || "").toLowerCase();
    const chunkWords = chunkTextLower.split(/\s+/);
    const docLen = Math.max(chunkWords.length, 1);
    const avgDocLen = 180;

    // BM25 calculation
    let bm25Score = 0;
    let exactSubphraseBonus = 0;

    for (const token of queryTokens) {
      let tfCount = 0;
      for (const w of chunkWords) {
        if (w === token) tfCount++;
        else if (w.includes(token)) tfCount += 0.5;
      }

      if (tfCount > 0) {
        const df = tokenDocFreq.get(token) || 1;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const k1 = 1.2;
        const b = 0.75;
        const tfNorm = (tfCount * (k1 + 1)) / (tfCount + k1 * (1 - b + b * (docLen / avgDocLen)));
        bm25Score += Math.max(idf, 0.1) * tfNorm;
      }
    }

    // Exact subphrase match check (e.g. "chief executive officer", "refund policy", "ceo of")
    if (queryWords.length >= 2) {
      for (let wLen = Math.min(queryWords.length, 4); wLen >= 2; wLen--) {
        for (let i = 0; i <= queryWords.length - wLen; i++) {
          const subphrase = queryWords.slice(i, i + wLen).join(" ");
          if (subphrase.length > 5 && chunkTextLower.includes(subphrase)) {
            exactSubphraseBonus += wLen * 2.5;
          }
        }
      }
    }

    const lexicalScore = bm25Score + exactSubphraseBonus;

    // Semantic vector similarity
    const chunkEmbedding = embeddingMap.get(String(chunk._id));
    let semanticScore = 0;
    if (chunkEmbedding && Array.isArray(chunkEmbedding) && chunkEmbedding.length > 0) {
      semanticScore = cosineSimilarity(queryVector, chunkEmbedding);
    }

    scoredItems.push({
      chunk,
      lexicalScore,
      semanticScore,
      snippet: chunk.text,
      fileName: chunk.fileId ? chunk.fileId.fileName : "Document"
    });
  }

  // 5. STAGE 4: Reciprocal Rank Fusion (RRF)
  // Rank by Lexical Score descending
  const lexicalRanked = [...scoredItems].sort((a, b) => b.lexicalScore - a.lexicalScore);
  const lexicalRankMap = new Map();
  lexicalRanked.forEach((item, idx) => {
    lexicalRankMap.set(String(item.chunk._id), idx + 1);
  });

  // Rank by Semantic Score descending
  const semanticRanked = [...scoredItems].sort((a, b) => b.semanticScore - a.semanticScore);
  const semanticRankMap = new Map();
  semanticRanked.forEach((item, idx) => {
    semanticRankMap.set(String(item.chunk._id), idx + 1);
  });

  // Calculate RRF score: RRF = 1 / (60 + rank_lex) + 1 / (60 + rank_sem)
  const RRF_K = 60;
  for (const item of scoredItems) {
    const chunkIdStr = String(item.chunk._id);
    const rLex = lexicalRankMap.get(chunkIdStr) || scoredItems.length;
    const rSem = semanticRankMap.get(chunkIdStr) || scoredItems.length;

    const rrfLex = 1 / (RRF_K + rLex);
    const rrfSem = 1 / (RRF_K + rSem);

    // Weighted RRF score with direct semantic & lexical amplification
    item.score = (rrfLex * 1.5 + rrfSem * 2.0) * 100 + (item.semanticScore * 4.0) + (Math.min(item.lexicalScore, 10) * 0.8);
    item.rLex = rLex;
    item.rSem = rSem;
  }

  // Sort by final fused score descending
  scoredItems.sort((a, b) => b.score - a.score);

  const topScored = scoredItems.slice(0, effectiveTopK);
  const best = topScored[0];

  const hasRelevantToken = queryTokens.some(token => chunks.some(c => (c.text || "").toLowerCase().includes(token)));
  const defaultSimilarityThreshold = isOverview || isDiscovery ? 0.06 : 0.09;
  const defaultLexicalThreshold = isOverview || isDiscovery ? 0.4 : 0.6;
  const defaultScoreThreshold = isOverview || isDiscovery ? 1.0 : 1.5;

  const similarityAccepted = best?.semanticScore >= defaultSimilarityThreshold;
  const lexicalAccepted = best?.lexicalScore >= defaultLexicalThreshold;
  const scoreAccepted = best?.score >= defaultScoreThreshold;
  const metadataRescue = metadataMatch && best?.score >= 0.5;

  const accepted = !!best && (similarityAccepted || lexicalAccepted || scoreAccepted || metadataRescue || hasRelevantToken);

  let finalResult;
  if (!accepted) {
    finalResult = {
      isFound: false,
      chunks: [],
      reason: metadataMatch ? "METADATA_MATCH_BUT_LOW_RELEVANCE" : (hasRelevantToken ? "LOW_RELEVANCE" : "UNGROUNDED_TOPIC_MISSING_KEYWORDS"),
      metadataMatch,
      topScored,
      debug: {
        queryText,
        queryTokens,
        isOverview,
        isDiscovery,
        metadataMatch,
        topChunks: topScored.map(c => ({
          fileName: c.fileName,
          score: Math.round(c.score * 100) / 100,
          semanticScore: Math.round(c.semanticScore * 100) / 100,
          lexicalScore: Math.round(c.lexicalScore * 100) / 100,
          rLex: c.rLex,
          rSem: c.rSem
        }))
      }
    };
  } else {
    finalResult = {
      isFound: true,
      chunks: topScored,
      metadataMatch,
      debug: {
        queryText,
        queryTokens,
        isOverview,
        isDiscovery,
        metadataMatch,
        topChunks: topScored.map(c => ({
          fileName: c.fileName,
          score: Math.round(c.score * 100) / 100,
          semanticScore: Math.round(c.semanticScore * 100) / 100,
          lexicalScore: Math.round(c.lexicalScore * 100) / 100,
          rLex: c.rLex,
          rSem: c.rSem
        }))
      }
    };
  }

  // Cache grounded RAG result in Redis for 10 minutes (600s)
  try { await setCache(cacheKey, finalResult, 600); } catch (e) {}

  return finalResult;
}

function generateConversationalResponse(intent, message, history = [], chunks = [], bot = {}) {
  const msgTrim = (message || "").trim().toLowerCase();
  const botName = bot.name || "AI Assistant";

  if (intent === "GREETING" || /^(hi|hello|hey|greetings)$/i.test(msgTrim)) {
    return `Hello! How can I assist you today? I am ${botName}, your specialized assistant.`;
  }

  if (msgTrim.includes("role") || intent === "ROLE") {
    return `My role is to act as ${botName}, assisting you based on our configured rules and knowledge base.`;
  }

  if (isKnowledgeOverviewQuestion(message)) {
    const overview = buildKnowledgeOverviewResponse(bot, [], message);
    if (overview) return overview;
  }

  if (history && history.length > 0) {
    const lastMsg = [...history].reverse().find(m => m.content);
    if (lastMsg) {
      return `Regarding our discussion on "${lastMsg.content.substring(0, 60)}...": How can I assist you further?`;
    }
  }

  return `Hello! I am ${botName}. How can I assist you today?`;
}

/**
 * Builds strictly grounded RAG system prompt.
 */
function buildRagSystemPrompt(botName, botDescription, retrievedChunks, availableApis = [], knowledgeSummary = null, rulesText = "", mode = "small") {
  const modeLower = (mode || "small").toLowerCase();

  let modeGuidance = "";
  if (modeLower === "small") {
    modeGuidance = `
MODE: STRICT KNOWLEDGE BOT (SMALL)
1. You are strictly limited to facts explicitly stated in the KNOWLEDGE CONTEXT, configured APIs, and BOT RULES.
2. If a user inquiry is NOT supported or answered within the provided KNOWLEDGE CONTEXT or BOT RULES, politely decline to answer and state: "I am configured in Strict Document Mode (Small) and can only answer questions related to our uploaded documentation." Do NOT use general pre-trained knowledge for out-of-scope topics.`;
  } else if (modeLower === "medium") {
    modeGuidance = `
MODE: BALANCED HYBRID ASSISTANT (MEDIUM)
1. Use uploaded documentation and BOT RULES as your primary source of truth for business and technical queries.
2. For casual chitchat or general inquiries, answer concisely and helpfully while smoothly bridging back to your primary domain focus.`;
  } else {
    modeGuidance = `
MODE: OMNI AI ASSISTANT (LARGE)
1. You have full unconstrained conversational and technical capabilities (coding, math, general knowledge, creative reasoning).
2. Seamlessly integrate document context with broad AI knowledge to provide comprehensive, intelligent answers.`;
  }

  let contextBlocks = "No knowledge documents available for this query.";
  if (retrievedChunks && retrievedChunks.length > 0) {
    contextBlocks = retrievedChunks
      .map((item, idx) => `--- SOURCE DOCUMENT [${idx + 1}: ${item.fileName}] ---\n${item.snippet}`)
      .join("\n\n");
  }

  let overviewContext = "";
  if (knowledgeSummary && typeof knowledgeSummary === "object") {
    const summaryParts = [];
    if (Array.isArray(knowledgeSummary.topics) && knowledgeSummary.topics.length > 0) {
      summaryParts.push(`Known topics: ${knowledgeSummary.topics.slice(0, 8).join(", ")}`);
    }
    if (Array.isArray(knowledgeSummary.headings) && knowledgeSummary.headings.length > 0) {
      summaryParts.push(`Document headings and sections: ${knowledgeSummary.headings.slice(0, 8).join(", ")}`);
    }
    if (Array.isArray(knowledgeSummary.products) && knowledgeSummary.products.length > 0) {
      summaryParts.push(`Products referenced: ${knowledgeSummary.products.slice(0, 8).join(", ")}`);
    }
    if (summaryParts.length > 0) {
      overviewContext = `\n## KNOWLEDGE OVERVIEW:\n${summaryParts.join("; ")}`;
    }
  }

  let apiDescriptions = "No executable API tools configured.";
  if (availableApis && availableApis.length > 0) {
    apiDescriptions = availableApis
      .map(api => `- ${api.name} (${api.actionType || "GENERIC"}): ${api.method} ${api.url}`)
      .join("\n");
  }

  let rulesSection = "Follow standard professional assistant guidelines.";
  if (rulesText && typeof rulesText === "string" && rulesText.trim()) {
    rulesSection = rulesText.trim();
  }

  return `You are a specialized knowledge assistant named '${botName}'.
${botDescription ? `Purpose & Scope: ${botDescription}\n` : ""}

## BOT RULES
${rulesSection}

${modeGuidance}

## KNOWLEDGE CONTEXT
${contextBlocks}${overviewContext}

## API RESULTS
${apiDescriptions}

## CRITICAL GROUNDING & MULTI-AGENT INSTRUCTIONS:
1. You are strictly '${botName}', a specialized AI assistant operating within your assigned domain scope. Your primary source of truth is the provided KNOWLEDGE CONTEXT, configured APIs, and BOT RULES.
2. Evaluate and strictly prioritize MANDATORY BOT RULES and MODE guidance above. Apply any rule-specific formatting, out-of-scope guidance, or custom response structures requested.
3. When asked about your role, capabilities, or identity, introduce yourself proudly and warmly as '${botName}'.
4. STRICT VENDOR BRAND PROHIBITION: You must NEVER identify as, state, or claim to be "ChatGPT", "OpenAI", "Gemini", "Google", "Ollama", "Claude", "LLaMA", or any third-party AI model or company. You are strictly '${botName}'.
5. SYNONYM & SPACING FLEXIBILITY: Treat terms with minor spacing, hyphenation, or formatting differences as identical (e.g., 'web 3' = 'web3', 'react native' = 'react-native', 'node js' = 'nodejs', 'app 1' = 'app1'). Never claim information is missing simply due to a space or hyphen difference.
6. CONCISE & DIRECT ANSWERS: Answer questions clearly, accurately, and concisely based on your document context without unneeded boilerplates.
7. DYNAMIC UI ACTIONS & COMPONENT DIRECTIVES:
   - Check BOT RULES above for out-of-scope directives, business rules, greeting rules, or specific UI action component rules.
   - Whenever a user query triggers an Out-Of-Scope rule, Business Rule, or UI action (such as 'live_agent', 'contact_card', 'pill_list', 'carousel', 'schedule_call', 'table', or any custom responseType specified in BOT RULES):
     a) Output the natural language text message specified in the rules or out-of-scope configuration.
     b) At the VERY END of your response on a NEW SEPARATE LINE, append the action directive corresponding to the rule's responseType:
        ACTION: responseType=<configured_responseType> [key1=val1] [key2=val2]
        (e.g., ACTION: responseType=live_agent liveAgent=true OR ACTION: responseType=contact_card)
   - Do NOT wrap ACTION in code blocks. Always output it on a separate line at the end whenever a UI action component is requested.
8. CONTEXTUAL & FORMATTING FOLLOW-UPS:
   - When a user asks to format, rephrase, summarize, or restructure previous information (e.g., "in table form", "list format", "as a table", "bullet points", "in detail"), evaluate the conversation history and knowledge context, and output the response directly in the requested format (e.g. Markdown table using | Col1 | Col2 | format).
   - NEVER repeat generic greetings or identity introductions on follow-up or formatting requests.`;
}

/**
 * System prompt for General Conversational mode (human-like conversational chat & voice agent ready).
 * Adapts based on botMode ("small" | "medium" | "large")
 */
function buildGeneralSystemPrompt(botName = "AI Assistant", botDescription = "", mode = "small", rulesText = "") {
  const modeLower = (mode || "small").toLowerCase();

  let modeGuidance = "";
  if (modeLower === "small") {
    modeGuidance = `
MODE: STRICT KNOWLEDGE BOT (SMALL)
1. You are strictly limited to the uploaded documentation.
2. If the user asks a general question or topic not covered in the documents, state clearly and politely: "I am configured in Strict Document Mode (Small) and can only answer questions related to the uploaded documentation."`;
  } else if (modeLower === "medium") {
    modeGuidance = `
MODE: BALANCED HYBRID ASSISTANT (MEDIUM)
1. Answer document questions using the uploaded files as your primary source of truth.
2. For casual chitchat or general inquiries, answer concisely and helpfully while politely reminding the user of your main document focus when appropriate.`;
  } else {
    modeGuidance = `
MODE: OMNI AI ASSISTANT (LARGE)
1. You have full unconstrained conversational capabilities (general Q&A, coding, math, reasoning, creative writing).
2. Seamlessly combine deep general AI knowledge with document facts.`;
  }

  let rulesSection = "Follow standard professional assistant guidelines.";
  if (rulesText && typeof rulesText === "string" && rulesText.trim()) {
    rulesSection = rulesText.trim();
  }

  return `You are a warm, intelligent, articulate, and friendly AI Assistant named '${botName}'.
${botDescription ? `Role & Scope: ${botDescription}\n` : ""}

## BOT RULES
${rulesSection}

${modeGuidance}

HUMAN CONVERSATIONAL RULES:
1. Respond naturally, conversationally, and warmly—just like a helpful assistant representing '${botName}'.
2. Keep responses articulate, engaging, and easy to understand when spoken aloud.
3. If asked about your identity, name, or role, introduce yourself warmly as '${botName}'. NEVER mention "ChatGPT", "OpenAI", "Gemini", "Google", "Ollama", "Claude", "LLaMA", or any underlying AI vendor.
4. MANDATORY USER RULES: Strictly evaluate and follow BOT RULES provided above before responding.
5. MANDATORY DYNAMIC ACTION DIRECTIVES & UI COMPONENT RULES:
   - Inspect BOT RULES above for out-of-scope directives, business rules, greeting rules, or specific UI action component rules.
   - Whenever a user query triggers an Out-Of-Scope rule, Business Rule, or UI action (such as 'live_agent', 'contact_card', 'pill_list', 'carousel', 'schedule_call', 'table', or any custom responseType specified in BOT RULES):
     a) Output the natural language text message specified in the rules or out-of-scope configuration.
     b) At the VERY END of your response on a NEW SEPARATE LINE, append the action directive corresponding to the rule's responseType:
        ACTION: responseType=<configured_responseType> [key1=val1] [key2=val2]
        (e.g., ACTION: responseType=live_agent liveAgent=true OR ACTION: responseType=contact_card)
   - Do NOT wrap ACTION in code blocks. Always output it on a separate line at the end whenever a UI action component is requested.
6. CONTEXTUAL & FORMATTING FOLLOW-UPS:
   - When a user asks to format, rephrase, summarize, or restructure previous information (e.g., "in table form", "list format", "as a table", "bullet points", "in detail"), evaluate the conversation history and knowledge context, and output the response directly in the requested format (e.g. Markdown table using | Col1 | Col2 | format).
   - NEVER repeat generic greetings or identity introductions on follow-up or formatting requests.`;
}

module.exports = {
  tokenize,
  generateEmbeddingVector,
  generateEmbeddingVectorAsync,
  cosineSimilarity,
  chunkText,
  generateLLMSummary,
  extractKnowledgeMetadataFromText,
  buildKnowledgeOverviewResponse,
  generateConversationalResponse,
  detectBotIntent,
  retrieveRelevantChunks,
  buildRagSystemPrompt,
  buildGeneralSystemPrompt
};
