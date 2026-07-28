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
 */
function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
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

/**
 * Generates high-density semantic vector embeddings via Ollama nomic-embed-text API.
 */
async function generateEmbeddingVectorAsync(text) {
  if (!text || typeof text !== "string") return generateEmbeddingVector(text);
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
        return data.embedding;
      }
    }
  } catch (err) {
    console.warn("⚠️ [EMBEDDINGS API NOTICE] Ollama nomic-embed-text offline, using feature vector fallback:", err.message);
  }
  return generateEmbeddingVector(text);
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

/**
 * Classifies incoming message intent into supported classes.
 */
function detectBotIntent(message, historyMessages = []) {
  if (!message || typeof message !== "string") return "GREETING";
  const trimmed = message.trim().toLowerCase();

  if (/^(hi|hello|hey|greetings|good\s+morning|good\s+afternoon|good\s+evening)$/i.test(trimmed)) {
    return "GREETING";
  }

  return "KNOWLEDGE_QUESTION";
}

/**
 * Performs Multi-Tenant Semantic Search strictly isolated by userId and botId.
 * Validates that key query terms literally exist within the document text.
 */
async function retrieveRelevantChunks(userId, botId, userQuestion, topK = 3, historyMessages = []) {
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

  const chunks = await BotChunk.find(filter).populate("fileId", "fileName fileType");
  if (!chunks || chunks.length === 0) {
    return {
      isFound: false,
      chunks: [],
      reason: "NO_DOCUMENTS"
    };
  }

  const combinedDocText = chunks.map(c => c.text.toLowerCase()).join(" ");
  const queryTokens = tokenize(queryText);

  // Validate topic grounding:
  // If user question has key non-stopword tokens (e.g., "phone pay", "react", "weather", "crypto"),
  // at least ONE key token must be explicitly present in the document text.
  // For queries with multiple key tokens (e.g. "phone pay"), ALL key tokens must exist in the document text!
  if (queryTokens.length > 0) {
    const missingTokens = queryTokens.filter(token => {
      // Check if token or stem exists in combined document text
      const stem = token.length > 4 ? token.substring(0, token.length - 2) : token;
      return !combinedDocText.includes(token) && !combinedDocText.includes(stem);
    });

    // If any key token in a specific query (like "pay" in "phone pay", or "react") is missing from document text:
    if (missingTokens.length > 0) {
      return {
        isFound: false,
        chunks: [],
        reason: "UNGROUNDED_TOPIC_MISSING_KEYWORDS"
      };
    }
  }

  const queryVector = await generateEmbeddingVectorAsync(queryText);
  const scoredChunks = [];

  for (const chunk of chunks) {
    const chunkTextLower = chunk.text.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (chunkTextLower.includes(token)) {
        score += 2.0;
      }
    }

    const chunkEmbedding = await BotEmbedding.findOne({ chunkId: chunk._id });
    if (chunkEmbedding && chunkEmbedding.embedding && chunkEmbedding.embedding.length > 0) {
      const cosSim = cosineSimilarity(queryVector, chunkEmbedding.embedding);
      if (cosSim > 0.15) {
        score += cosSim * 5.0;
      }
    }

    if (score >= 1.5) {
      const fileName = chunk.fileId ? chunk.fileId.fileName : "Document";
      scoredChunks.push({
        chunk,
        score,
        snippet: chunk.text,
        fileName
      });
    }
  }

  scoredChunks.sort((a, b) => b.score - a.score);
  const topScored = scoredChunks.slice(0, topK);

  if (topScored.length === 0) {
    return {
      isFound: false,
      chunks: [],
      reason: "LOW_RELEVANCE"
    };
  }

  return {
    isFound: true,
    chunks: topScored
  };
}

/**
 * Builds strictly grounded RAG system prompt.
 */
function buildRagSystemPrompt(botName, botDescription, retrievedChunks, availableApis = []) {
  let contextBlocks = "No knowledge documents available for this query.";
  if (retrievedChunks && retrievedChunks.length > 0) {
    contextBlocks = retrievedChunks
      .map((item, idx) => `--- SOURCE DOCUMENT [${idx + 1}: ${item.fileName}] ---\n${item.snippet}`)
      .join("\n\n");
  }

  let apiDescriptions = "No executable API tools configured.";
  if (availableApis && availableApis.length > 0) {
    apiDescriptions = availableApis
      .map(api => `- ${api.name} (${api.actionType || "GENERIC"}): ${api.method} ${api.url}`)
      .join("\n");
  }

  return `You are a STRICTLY GROUNDED knowledge-base product agent named '${botName}'.
${botDescription ? `Purpose & Scope: ${botDescription}\n` : ""}

## GROUNDED KNOWLEDGE BASE:
${contextBlocks}

## AVAILABLE ACTION TOOLS:
${apiDescriptions}

## CRITICAL STRICT GROUNDING INSTRUCTIONS:
1. You are ONLY allowed to answer questions using information directly found in the GROUNDED KNOWLEDGE BASE or AVAILABLE ACTION TOOLS above.
2. You are ABSOLUTELY FORBIDDEN from using your pre-trained memory to answer questions about topics not explicitly stated in the GROUNDED KNOWLEDGE BASE (such as Phone Pay, React, JavaScript, programming concepts, jokes, sports, politics, weather, movies).
3. If the user's question cannot be answered directly from the GROUNDED KNOWLEDGE BASE above, respond EXACTLY with:
   "I am ${botName}, a specialized assistant for the configured knowledge base. Your question is outside my available knowledge scope. Please ask a question related to the uploaded documents or configured tools."
4. Always identify yourself as '${botName}'. When asked "Who are you?", respond EXACTLY with:
   "I am ${botName}, a specialized assistant trained only on the uploaded knowledge base and configured APIs."
5. If the user asks for a deep, complex, or detailed explanation regarding platform setups, pricing matrix adjustments, or custom system automations, reply EXACTLY with:
   "I will gladly capture your primary context details right here to instantly connect you directly with our specialized engineering team for a full custom walkthrough."`;
}

module.exports = {
  tokenize,
  generateEmbeddingVector,
  generateEmbeddingVectorAsync,
  cosineSimilarity,
  chunkText,
  generateLLMSummary,
  detectBotIntent,
  retrieveRelevantChunks,
  buildRagSystemPrompt
};
