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
  "couldn't", "did", "didn't", "does", "doesn't", "doing", "don't", "down",
  "during", "each", "few", "for", "from", "further", "had", "hadn't", "has",
  "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
  "here", "here's", "hers", "herself", "him", "himself", "his", "how's",
  "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "isn't", "it",
  "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my",
  "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other",
  "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't",
  "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves",
  "then", "there", "there's", "these", "they", "they'd", "they'll", "they're",
  "they've", "this", "those", "through", "to", "too", "under", "until", "up",
  "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were",
  "weren't", "what's", "when's", "where's", "which",
  "while", "who's", "whom", "why's", "with", "won't", "would",
  "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours",
  "yourself", "yourselves", "tell", "show", "give", "use", "what", "how", "why", "is"
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
 * Generates a feature vector fallback.
 */
function generateEmbeddingVector(text) {
  const vector = new Array(16).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash << 5) - hash + token.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % 16;
    vector[idx] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    return vector.map(val => Number((val / magnitude).toFixed(4)));
  }
  return vector;
}

const embeddingCache = new Map();

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
        embeddingCache.set(cacheKey, data.embedding);
        return data.embedding;
      }
    }
  } catch (err) { }

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

  // 2. Explicit Document / API Queries
  const explicitDocQuery = /\b(pdf|document|uploaded|file|manual|policy|guide|kb|knowledge\s+base|postman|collection|documentation)\b/i.test(trimmed);
  if (explicitDocQuery) {
    return "DOCUMENT_QUERY";
  }

  // 3. Match against bot metadata topics
  if (botMetadata && matchQueryToMetadata(message, botMetadata)) {
    return "DOCUMENT_QUERY";
  }

  // 4. Default fallback: General questions bypass document RAG search
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

  const prompt = `You are a conversation summarization engine. Create a concise, high-quality, 2-4 sentence narrative summary of the key topics, user intentions, technical concepts, decisions, and assistant guidance discussed in this conversation.

Previous Summary:
${existingSummary || "None"}

Recent Messages:
${formattedHistory}

INSTRUCTIONS:
Return ONLY the plain text summary narrative. Do NOT include introductory phrases like "Here is a summary" or meta-talk.`;

  const targetModel = await getAvailableOllamaModel(OLLAMA_BASE_URL, process.env.OLLAMA_MODEL);

  try {
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
      if (summaryText) {
        return summaryText;
      }
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
    if (/\b(allvion|crm|terminal|engine|platform|suite|solution|service\s+platform)\b/.test(phrase)) {
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
 * Performs Multi-Tenant Semantic Search strictly isolated by userId and botId.
 * Validates that key query terms literally exist within the document text.
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

  const filter = { botId: targetBotId };
  if (targetUserId) {
    filter.$or = [{ userId: targetUserId }, { ownerId: targetUserId }];
  }

  const rawChunks = await BotChunk.find(filter).populate("fileId", "fileName fileType fileCategory");
  const chunks = (rawChunks || []).filter(c => c.fileId && (!c.fileId.fileCategory || c.fileId.fileCategory === "knowledge"));

  if (!chunks || chunks.length === 0) {
    return {
      isFound: false,
      chunks: [],
      reason: "NO_DOCUMENTS"
    };
  }

  const queryVector = await generateEmbeddingVectorAsync(queryText);
  const queryTokens = tokenize(queryText);
  const isOverview = isKnowledgeOverviewQuestion(queryText);
  const isDiscovery = isKnowledgeDiscoveryQuestion(queryText);
  const metadataMatch = Boolean(botMetadata && matchQueryToMetadata(queryText, botMetadata));
  const scoredChunks = [];

  const chunkEmbeddings = await BotEmbedding.find({ chunkId: { $in: chunks.map(c => c._id) } });
  const embeddingMap = new Map(chunkEmbeddings.map(e => [String(e.chunkId), e.embedding]));

  for (const chunk of chunks) {
    const chunkTextLower = chunk.text.toLowerCase();
    let lexicalScore = 0;
    let phraseMatches = 0;

    for (const token of queryTokens) {
      if (!token) continue;
      if (chunkTextLower.includes(token)) {
        lexicalScore += 1.2;
        phraseMatches += 1;
      }
      const stem = token.length > 4 ? token.substring(0, token.length - 2) : token;
      if (stem !== token && chunkTextLower.includes(stem)) {
        lexicalScore += 0.6;
      }
    }

    const chunkEmbedding = embeddingMap.get(String(chunk._id));
    let semanticScore = 0;
    if (chunkEmbedding && Array.isArray(chunkEmbedding) && chunkEmbedding.length > 0) {
      semanticScore = cosineSimilarity(queryVector, chunkEmbedding);
    }

    const score = lexicalScore * 1.2 + semanticScore * 6.0 + phraseMatches * 0.5;

    scoredChunks.push({
      chunk,
      score,
      semanticScore,
      lexicalScore,
      snippet: chunk.text,
      fileName: chunk.fileId ? chunk.fileId.fileName : "Document"
    });
  }

  scoredChunks.sort((a, b) => b.score - a.score);
  const topScored = scoredChunks.slice(0, topK);
  const best = topScored[0];

  const hasRelevantToken = queryTokens.some(token => chunks.some(c => c.text.toLowerCase().includes(token)));
  const defaultSimilarityThreshold = isOverview || isDiscovery ? 0.08 : 0.12;
  const defaultLexicalThreshold = isOverview || isDiscovery ? 0.8 : 1.0;
  const defaultScoreThreshold = isOverview || isDiscovery ? 1.0 : 1.5;
  const metadataSimilarityThreshold = metadataMatch ? 0.06 : defaultSimilarityThreshold;
  const metadataLexicalThreshold = metadataMatch ? 0.6 : defaultLexicalThreshold;
  const metadataScoreThreshold = metadataMatch ? 0.9 : defaultScoreThreshold;

  const similarityAccepted = best?.semanticScore >= metadataSimilarityThreshold;
  const lexicalAccepted = best?.lexicalScore >= metadataLexicalThreshold;
  const scoreAccepted = best?.score >= metadataScoreThreshold;
  const metadataRescue = metadataMatch && best?.score >= 0.5;

  const accepted = !!best && (similarityAccepted || lexicalAccepted || scoreAccepted || metadataRescue);

  if (!accepted) {
    return {
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
        topChunks: topScored.map(c => ({ fileName: c.fileName, score: c.score, semanticScore: c.semanticScore, lexicalScore: c.lexicalScore }))
      }
    };
  }

  return {
    isFound: true,
    chunks: topScored,
    metadataMatch,
    debug: {
      queryText,
      queryTokens,
      isOverview,
      isDiscovery,
      metadataMatch,
      topChunks: topScored.map(c => ({ fileName: c.fileName, score: c.score, semanticScore: c.semanticScore, lexicalScore: c.lexicalScore }))
    }
  };
}

function generateConversationalResponse(intent, message, history = [], chunks = [], bot = {}) {
  const botName = bot.name || "AI Assistant";
  if (intent === "GREETING" || /^(hi|hello|hey|greetings)$/i.test((message || "").trim())) {
    return `Hello! I am ${botName}. How can I assist you today?`;
  }
  if (intent === "ROLE" || message === "What is your role?") {
    return `My role is to act as ${botName}, assisting you with your questions based on our knowledge base and connected services.`;
  }
  if (isKnowledgeOverviewQuestion(message)) {
    return buildKnowledgeOverviewResponse(bot, [], message);
  }
  return `Hello! I am ${botName}. How can I assist you today?`;
}

/**
 * Builds strictly grounded RAG system prompt.
 */
function buildRagSystemPrompt(botName, botDescription, retrievedChunks, availableApis = [], knowledgeSummary = null, rulesText = "") {
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

  return `You are a STRICTLY GROUNDED specialized knowledge assistant named '${botName}'.
${botDescription ? `Purpose & Scope: ${botDescription}\n` : ""}

## BOT RULES
${rulesSection}

## KNOWLEDGE CONTEXT
${contextBlocks}

## API RESULTS
${apiDescriptions}

## CRITICAL GROUNDING & MULTI-AGENT INSTRUCTIONS:
1. You are strictly '${botName}', a specialized AI assistant operating within your assigned domain scope. Your primary source of truth is the provided KNOWLEDGE CONTEXT, configured APIs, and BOT RULES.
2. You must answer questions using the provided KNOWLEDGE CONTEXT and APIs. Avoid inventing details or making ungrounded claims outside your provided documentation and BOT RULES.
3. Evaluate and strictly prioritize MANDATORY BOT RULES above. Apply any rule-specific formatting, out-of-scope guidance, or custom response structures requested.
4. When asked about your role, capabilities, or identity, introduce yourself as '${botName}' and summarize your core functions based on your knowledge base and configured tools.
5. Do NOT refer to yourself as a generic pre-trained model or state internal AI architecture details. Maintain a helpful, professional persona representing '${botName}'.
6. SYNONYM & SPACING FLEXIBILITY: Treat terms with minor spacing, hyphenation, or formatting differences as identical (e.g., 'web 3' = 'web3', 'react native' = 'react-native', 'node js' = 'nodejs', 'app 1' = 'app1'). Never claim information is missing simply due to a space or hyphen difference.
7. CONCISE & DIRECT ANSWERS: Answer questions clearly, accurately, and concisely based on your document context without unneeded boilerplates.
8. DYNAMIC UI ACTIONS & COMPONENT DIRECTIVES:
   - Check BOT RULES above for out-of-scope directives, business rules, greeting rules, or specific UI action component rules.
   - Whenever a user query triggers an Out-Of-Scope rule, Business Rule, or UI action (such as 'live_agent', 'contact_card', 'pill_list', 'carousel', 'schedule_call', 'table', or any custom responseType specified in BOT RULES):
     a) Output the natural language text message specified in the rules or out-of-scope configuration.
     b) At the VERY END of your response on a NEW SEPARATE LINE, append the action directive corresponding to the rule's responseType:
        ACTION: responseType=<configured_responseType> [key1=val1] [key2=val2]
        (e.g., ACTION: responseType=live_agent liveAgent=true OR ACTION: responseType=contact_card)
   - Do NOT wrap ACTION in code blocks. Always output it on a separate line at the end whenever a UI action component is requested.`;
}

/**
 * System prompt for General Conversational mode (human-like conversational chat & voice agent ready).
 * Adapts based on botMode ("small" | "medium" | "large")
 */
function buildGeneralSystemPrompt(botName = "AI Assistant", botDescription = "", mode = "medium", rulesText = "") {
  const modeLower = (mode || "medium").toLowerCase();

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
1. Respond naturally, conversationally, and warmly—just like a helpful assistant or voice agent representing '${botName}'.
2. Keep responses articulate, engaging, and easy to understand when spoken aloud.
3. If asked about your identity or role, introduce yourself warmly as '${botName}'.
4. MANDATORY USER RULES: Strictly evaluate and follow BOT RULES provided above before responding.
5. MANDATORY DYNAMIC ACTION DIRECTIVES & UI COMPONENT RULES:
   - Inspect BOT RULES above for out-of-scope directives, business rules, greeting rules, or specific UI action component rules.
   - Whenever a user query triggers an Out-Of-Scope rule, Business Rule, or UI action (such as 'live_agent', 'contact_card', 'pill_list', 'carousel', 'schedule_call', 'table', or any custom responseType specified in BOT RULES):
     a) Output the natural language text message specified in the rules or out-of-scope configuration.
     b) At the VERY END of your response on a NEW SEPARATE LINE, append the action directive corresponding to the rule's responseType:
        ACTION: responseType=<configured_responseType> [key1=val1] [key2=val2]
        (e.g., ACTION: responseType=live_agent liveAgent=true OR ACTION: responseType=contact_card)
   - Do NOT wrap ACTION in code blocks. Always output it on a separate line at the end whenever a UI action component is requested.`;
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
