/**
 * AI Gateway Abstraction (`aiGateway.js`)
 * Centralized Model Routing, Multi-Node Load Balancing, Priority Dispatching,
 * Streaming Response Parsing, and Fallback Execution.
 *
 * Usage Example:
 * const result = await aiGateway.generateStream({
 *   provider: "auto", // "auto" | "ollama" | "openai" | "gemini"
 *   model: "best",     // "best" | specific model string
 *   messages: [...],   // [{ role, content }]
 *   res: sseResponseStream,
 *   userPriority: 10,
 *   jobId: "bot_123_456"
 * });
 */

const { performance } = require("perf_hooks");
const https = require("https");
const http = require("http");
const { Readable } = require("stream");
const { selectBestClusterNode, clusterState } = require("./ollamaHelper");
const { selectBestClusterNodeWithPreemption, registerActiveJob, unregisterActiveJob } = require("./priorityDispatcher");

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 });

/**
 * Accurately estimates token count for a text or message array
 * Standard rule of thumb: ~3.8 characters per token + framing overhead
 */
function estimateTokens(input) {
  if (!input) return 0;
  if (Array.isArray(input)) {
    let count = 0;
    for (const msg of input) {
      const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      count += estimateTokens(contentStr) + 4; // 4 tokens per message framing overhead
    }
    return Math.max(1, count);
  }
  const str = String(input).trim();
  if (!str) return 0;
  return Math.max(1, Math.round(str.length / 3.8));
}

/**
 * Per-key rate limit blocklist.

 * Maps a specific API key string → the Date until which it is blocked.
 * This is purely in-memory and resets on server restart (acceptable — keys
 * re-block themselves on the next 429 quickly enough).
 */
const keyBlocklist = new Map(); // Map<apiKeyString, Date>

/**
 * Returns true if this specific key has hit a 429 and is still in its cooldown window.
 */
function isKeyBlocked(key) {
  if (!key) return false;
  const blockedUntil = keyBlocklist.get(key);
  if (!blockedUntil) return false;
  if (blockedUntil > new Date()) return true;
  keyBlocklist.delete(key); // Cooldown expired — unblock
  return false;
}

/**
 * Blocks a specific API key for `durationMs` milliseconds (default 90 seconds).
 * Called immediately when a 429 or 401 is received for that key.
 */
function blockKey(key, durationMs = 90000) {
  if (!key) return;
  keyBlocklist.set(key, new Date(Date.now() + durationMs));
  const maskedKey = key.length > 10 ? `...${key.slice(-6)}` : key;
  console.warn(`🚫 [KEY BLOCKED] API key ${maskedKey} is blocked for ${durationMs / 1000}s due to rate limit / auth failure.`);
}

/**
 * Selects the best available (non-blocked) key from a list of candidate keys.
 * All keys come from DB (decrypted SecretKey on each ServerNode).
 * Never reads from process.env — admin manages all keys via the dashboard.
 *
 * @param {string[]} candidateKeys  - Decrypted key strings from DB nodes
 * @returns {string}  First non-blocked key, or first key as last-resort fallback
 */
function getProviderApiKey(candidateKeys = []) {
  const validKeys = candidateKeys.filter(k => k && typeof k === "string" && k.trim().length > 5 && !/[\u2022\*]/.test(k));
  if (validKeys.length === 0) return "";
  const available = validKeys.find(k => !isKeyBlocked(k));
  if (available) return available;
  // All keys blocked — return the one whose block expires soonest (best chance of working)
  const sorted = validKeys.slice().sort((a, b) => {
    const aExp = (keyBlocklist.get(a) || new Date(0)).getTime();
    const bExp = (keyBlocklist.get(b) || new Date(0)).getTime();
    return aExp - bExp;
  });
  console.warn(`⚠️ [KEY POOL EXHAUSTED] All ${validKeys.length} keys are rate-limited. Using soonest-expiring key as last resort.`);
  return sorted[0];
}

async function safeFetch(url, options = {}) {
  const reqHeaders = { ...(options.headers || {}) };
  if (!reqHeaders["User-Agent"]) {
    reqHeaders["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  }

  const isLocalhost = url.includes("127.0.0.1") || url.includes("localhost");
  const timeoutMs = options.timeout || options.connectTimeout || (isLocalhost ? 10000 : 90000);

  let signal = options.signal;
  if (!signal) {
    try {
      signal = AbortSignal.timeout(timeoutMs);
    } catch (e) {}
  }

  const fetchOptions = {
    method: options.method || "GET",
    headers: reqHeaders,
    body: options.body,
    signal
  };

  const response = await fetch(url, fetchOptions);
  const rawStream = response.body ? Readable.fromWeb(response.body) : null;

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    rawStream
  };
}

/**
 * Reads the entire text body from a Node.js raw IncomingMessage stream
 * Useful for logging full error response bodies from Ollama, Gemini, etc.
 */
async function readStreamBody(rawStream) {
  if (!rawStream) return "";
  try {
    return await new Promise((resolve) => {
      let body = "";
      const timeout = setTimeout(() => resolve(body), 3000);
      rawStream.on("data", (chunk) => { body += chunk.toString("utf8"); });
      rawStream.on("end", () => { clearTimeout(timeout); resolve(body); });
      rawStream.on("error", () => { clearTimeout(timeout); resolve(body); });
      if (rawStream.destroyed || rawStream.readableEnded) {
        clearTimeout(timeout);
        resolve(body);
      }
    });
  } catch (e) {
    return "";
  }
}

/**
 * Helper to determine if a node or provider is a Local Model vs Cloud Model
 */
function isLocalNodeOrProvider(nodeOrProvider) {
  if (!nodeOrProvider) return true;
  if (typeof nodeOrProvider === "string") {
    const prov = nodeOrProvider.toLowerCase();
    if (prov === "openai" || prov === "gemini" || prov === "glm" || prov === "nvidia" || prov === "claude" || prov === "anthropic") return false;
    return true;
  }

  const format = (nodeOrProvider.format || "").toLowerCase();
  const url = (nodeOrProvider.url || "").toLowerCase();

  if (format === "openai" || format === "gemini" || format === "glm") {
    if (url.includes("googleapis.com") || url.includes("openai.com") || url.includes("integrate.api.nvidia.com") || url.includes("anthropic.com")) {
      return false;
    }
  }

  if (url.includes("googleapis.com") || url.includes("openai.com") || url.includes("integrate.api.nvidia.com") || url.includes("anthropic.com") || url.includes("trycloudflare.com") || url.includes("ollama.com") || url.includes("codegene")) {
    return false;
  }

  if ((format === "ollama" || format === "llama") && (url.includes("localhost") || url.includes("127.0.0.1") || url.includes(":11434"))) {
    return true;
  }

  return format !== "gemini" && format !== "openai" && format !== "glm";
}

/**
 * Builds provider-aware context payload enforcing the exact Context Priority Order:
 * 1. Bot Rules / System Prompt
 * 2. Retrieved Knowledge Base Chunks (RAG)
 * 3. Recent Messages (6–10 messages)
 * 4. Rolling Summary (Cloud Models Only)
 */
function buildProviderAwareContextPayload({ messages = [], conversationSummary = "", isLocal = false }) {
  let systemMsg = null;
  let summaryText = (conversationSummary && typeof conversationSummary === "string") ? conversationSummary.trim() : "";
  const recentMsgs = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") {
      const content = msg.content || "";
      const isSumm = msg.isSummary ||
        content.startsWith("[CONVERSATION SUMMARY]") ||
        content.startsWith("Conversation Summary:") ||
        content.startsWith("Summary:");

      if (isSumm) {
        if (!summaryText && content) {
          summaryText = content.replace(/^(?:\[CONVERSATION SUMMARY\]|Conversation Summary:|Summary:)\s*/i, "").trim();
        }
      } else if (!systemMsg) {
        systemMsg = msg;
      }
    } else if (msg.role === "summary" || msg.isSummary) {
      if (!summaryText && msg.content) {
        summaryText = String(msg.content).trim();
      }
    } else {
      recentMsgs.push(msg);
    }
  }

  // Bound recent messages to last 10 (5 turns)
  const boundedRecentMsgs = recentMsgs.slice(-10);

  const finalPayload = [];
  if (systemMsg) {
    finalPayload.push(systemMsg);
  }

  boundedRecentMsgs.forEach(m => finalPayload.push({ role: m.role, content: m.content }));

  // Requirement 3 & 6: Only send Rolling Summary to Cloud Models (rank 4 priority)
  if (!isLocal && summaryText) {
    finalPayload.push({
      role: "system",
      content: `[CONVERSATION SUMMARY]\n${summaryText}`
    });
  }

  return finalPayload;
}

/**
 * Transforms raw internal AI provider errors into clean, professional user-facing messages.
 * Prevents leaking provider JSON, URLs, developer/account names, and internal credentials.
 */
function sanitizeUserFacingError(rawError, statusCode = 0) {
  return "I'm sorry, I am experiencing difficulty connecting at the moment due to high traffic. Please try again in a few minutes.";
}

class AIGateway {
  /**
   * Main entry point for streaming AI responses to SSE or custom handlers
   */
  async generateStream({
    provider = "auto",
    model = "best",
    customUrl = null,
    messages = [],
    attachments = [],
    conversationSummary = null,
    res = null,
    userPriority = 10,
    jobId = null,
    userId = "system",
    onToken = null,
    preResolvedNodeHint = null
  }) {
    const providerLower = (provider || "auto").toLowerCase();

    if (providerLower === "auto" || providerLower === "ollama") {
      return await this._streamOllamaCluster({
        model,
        customUrl,
        messages,
        attachments,
        conversationSummary,
        res,
        userPriority,
        jobId,
        userId,
        onToken,
        preResolvedNodeHint
      });
    }

    if (providerLower === "openai") {
      const { clusterState } = require("./ollamaHelper");
      const hasRealOpenAiNode = clusterState.some(n =>
        n.isActive !== false &&
        n.url && n.url.includes("api.openai.com") &&
        n.secretKey && n.secretKey.length > 10 &&
        !n.secretKey.startsWith("sk-ollam") &&
        !/[\u2022\*]/.test(n.secretKey)
      );

      if (hasRealOpenAiNode) {
        try {
          return await this._streamCloudOpenAI({
            model: model === "best" ? "gpt-4o-mini" : model,
            messages,
            attachments,
            conversationSummary,
            res,
            onToken
          });
        } catch (openAiErr) {
          console.warn("⚠️ [GATEWAY STRICT] Cloud OpenAI direct failed:", openAiErr.message, "-> Trying cluster OpenAI nodes.");
        }
      }
      return await this._streamOllamaCluster({
        model: model || "best",
        customUrl,
        messages,
        attachments,
        conversationSummary,
        res,
        userPriority,
        jobId,
        userId,
        onToken,
        strictProvider: "openai",
        preResolvedNodeHint
      });
    }

    if (providerLower === "gemini" || (model && model.toLowerCase().includes("gemini") && !/^(auto|best)$/i.test(model))) {
      const geminiTargetModel = (model === "best" || model === "gemini-2.5-flash" || model === "gemini-2.0-flash")
        ? "gemini-3.5-flash-lite"
        : (model || "gemini-3.5-flash-lite");

      try {
        return await this._streamCloudGemini({
          model: geminiTargetModel,
          messages,
          attachments,
          conversationSummary,
          res,
          onToken
        });
      } catch (geminiErr) {
        console.warn("⚠️ [GATEWAY STRICT] Cloud Gemini direct failed:", geminiErr.message, "-> Trying cluster Gemini nodes.");
        return await this._streamOllamaCluster({
          model: geminiTargetModel,
          customUrl,
          messages,
          attachments,
          conversationSummary,
          res,
          userPriority,
          jobId,
          userId,
          onToken,
          strictProvider: "gemini",
          preResolvedNodeHint
        });
      }
    }

    if (providerLower === "glm" || providerLower === "nvidia") {
      try {
        return await this._streamCloudGLM({
          model: model === "best" ? "z-ai/glm-5.2" : model,
          messages,
          conversationSummary,
          res,
          onToken
        });
      } catch (glmErr) {
        console.warn("⚠️ [GATEWAY STRICT] Cloud GLM direct failed:", glmErr.message, "-> Trying cluster GLM nodes.");
        return await this._streamOllamaCluster({
          model: model || "z-ai/glm-5.2",
          customUrl,
          messages,
          conversationSummary,
          res,
          userPriority,
          jobId,
          userId,
          onToken,
          strictProvider: "glm",
          preResolvedNodeHint
        });
      }
    }

    // Default & Cluster Stream for Ollama/vLLM & Auto
    return await this._streamOllamaCluster({
      model: model || "best",
      customUrl,
      messages,
      conversationSummary,
      res,
      userPriority,
      jobId,
      userId,
      onToken,
      strictProvider: providerLower !== "auto" ? providerLower : null,
      preResolvedNodeHint
    });
  }

  /**
   * Streams response from Cluster Server Nodes with Provider Pools, Priority Routing,
   * Least-Loaded Balancing, Intra-Pool & Cross-Pool Failover, and Observability Metrics.
   */
  async _streamOllamaCluster({ model, customUrl, messages, attachments = [], conversationSummary = null, res, userPriority, jobId, userId, onToken, maxTokens = null, strictProvider = null, preResolvedNodeHint = null }) {
    const { getProviderPools, refreshClusterNodesFromDB } = require("./ollamaHelper");
    await refreshClusterNodesFromDB();

    const ServerNode = require("../models/ServerNode");
    const { geminiPool, glmPool, llamaPool, openAiPool, allNodes } = getProviderPools();

    // 1. Find nodes that explicitly support the requested model
    const matchedNodes = (model && model !== "best" && model !== "auto")
      ? allNodes.filter(n =>
          (Array.isArray(n.supportedModels) && n.supportedModels.some(m => m && m.toLowerCase() === model.toLowerCase())) ||
          (n.defaultModel && n.defaultModel.toLowerCase() === model.toLowerCase()) ||
          (n.url && n.url.includes("ai.codegene.io") && (model.includes("deepseek") || model.includes("kimi") || model.includes("glm") || model.includes("qwen")))
        )
      : [];

    // 2. Strict Mode Provider Isolation: Route strictly within the selected provider pool
    const isExplicitModel = model && model !== "best" && model !== "auto";
    const isGeminiModel = (strictProvider === "gemini") || (model && model.toLowerCase().includes("gemini"));
    const isGLMModel = (strictProvider === "glm") || (model && (model.toLowerCase().includes("glm") || model.toLowerCase().includes("nvidia") || model.toLowerCase().includes("z-ai")));
    const isOpenAIModel = (strictProvider === "openai") || (model && (model.toLowerCase().startsWith("gpt-") || model.toLowerCase().includes("o1") || model.toLowerCase().includes("o3")));
    const isOllamaModel = (strictProvider === "ollama") || (model && (model.toLowerCase().includes("qwen") || model.toLowerCase().includes("deepseek") || model.toLowerCase().includes("kimi") || model.toLowerCase().includes("llama")));

    // ALWAYS prioritize matchedNodes first — these are the nodes that explicitly host the requested model.
    // If matchedNodes has results, use them as the primary pool regardless of provider classification.
    let poolsHierarchy;
    if (matchedNodes.length > 0) {
      if (isGeminiModel) poolsHierarchy = [matchedNodes, geminiPool];
      else if (isGLMModel) poolsHierarchy = [matchedNodes, glmPool];
      else if (isOpenAIModel) poolsHierarchy = [matchedNodes, openAiPool];
      else if (isOllamaModel) poolsHierarchy = [matchedNodes, llamaPool];
      else poolsHierarchy = [matchedNodes, allNodes];
    } else if (isExplicitModel || strictProvider) {
      if (isOpenAIModel) {
        poolsHierarchy = [openAiPool];
      } else if (isGeminiModel) {
        poolsHierarchy = [geminiPool];
      } else if (isGLMModel) {
        poolsHierarchy = [glmPool];
      } else if (isOllamaModel) {
        poolsHierarchy = [llamaPool];
      } else {
        poolsHierarchy = [allNodes];
      }
    } else {
      // Auto / Best Mode:
      // Dynamically discover active server pools from DB.
      // Prioritize active Ollama and Gemini nodes according to active status and priority.
      const candidateNodes = allNodes.filter(n => n.isActive !== false && n.status !== "INACTIVE");
      const activeNodes = candidateNodes.length > 0 ? candidateNodes : allNodes.filter(n => n.isActive !== false);

      const activeOllama = activeNodes.filter(n => n.format === "ollama" || (!n.url.includes("googleapis.com") && !n.url.includes("openai.com") && !n.url.includes("integrate.api.nvidia.com")));
      const activeGemini = activeNodes.filter(n => n.format === "gemini" || n.url.includes("googleapis.com"));
      const activeOther = activeNodes.filter(n => !activeOllama.includes(n) && !activeGemini.includes(n));

      const maxOllamaPriority = activeOllama.length > 0 ? Math.max(...activeOllama.map(n => n.priorityScore || n.priority || 10)) : -1;
      const maxGeminiPriority = activeGemini.length > 0 ? Math.max(...activeGemini.map(n => n.priorityScore || n.priority || 10)) : -1;

      poolsHierarchy = [];
      if (maxGeminiPriority > maxOllamaPriority) {
        if (activeGemini.length > 0) poolsHierarchy.push(activeGemini);
        if (activeOllama.length > 0) poolsHierarchy.push(activeOllama);
      } else {
        if (activeOllama.length > 0) poolsHierarchy.push(activeOllama);
        if (activeGemini.length > 0) poolsHierarchy.push(activeGemini);
      }
      if (activeOther.length > 0) poolsHierarchy.push(activeOther);
      if (poolsHierarchy.length === 0) poolsHierarchy.push(allNodes);
    }

    let selectedNode = null;
    let selectedModel = null;
    let response = null;
    let errorMessage = "";
    let streamedSuccessfully = false;
    let accumulatedResponseText = "";
    let ttft = 0;
    let firstTokenTimestamp = null;
    const llmStartTime = performance.now();

    const abortController = new AbortController();
    const activeJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/event-stream"
    };

    const triedNodeIds = new Set();
    const now = new Date();

    try {
      // Cross-Pool Failover Loop: Gemini Pool -> LLaMA Pool -> OpenAI Pool
      for (const currentPool of poolsHierarchy) {
      if (streamedSuccessfully || (response && response.ok)) break;

      let poolCandidates = currentPool.filter(n =>
        !triedNodeIds.has(n.id) &&
        n.status !== "INACTIVE" &&
        !(n.status === "RATE_LIMITED" && n.retryAfter && new Date(n.retryAfter) > now)
      );

      // High Availability Recovery: If all nodes in pool were marked INACTIVE, force-recover active nodes
      if (poolCandidates.length === 0) {
        poolCandidates = currentPool.filter(n => !triedNodeIds.has(n.id));
        poolCandidates.forEach(n => {
          n.status = "ACTIVE";
          if (n.id && n.id.length === 24) {
            ServerNode.findByIdAndUpdate(n.id, { status: "ACTIVE", consecutiveFailures: 0, retryAfter: null })
              .catch(err => console.error("Notice: ServerNode status recovery failed:", err.message || err));
          }
        });
      }

      if (poolCandidates.length === 0) continue;

      // Intra-Pool Routing Strategy: Priority-Based + Least-Loaded Load Balancing
      // 1. Sort candidates by priorityScore (descending: highest priority first)
      // 2. Within same priority score, sort by activeRequests (ascending: least-loaded first)
      poolCandidates.sort((a, b) => {
        if ((b.priorityScore || 10) !== (a.priorityScore || 10)) {
          return (b.priorityScore || 10) - (a.priorityScore || 10);
        }
        return a.activeRequests - b.activeRequests;
      });

      // Promote pre-resolved node hint to index 0 if present in candidates (ensures search & generation node consistency)
      if (preResolvedNodeHint) {
        const hintId = preResolvedNodeHint.id || preResolvedNodeHint._id?.toString();
        const hintIndex = poolCandidates.findIndex(n => (hintId && n.id === hintId) || (preResolvedNodeHint.url && n.url === preResolvedNodeHint.url));
        if (hintIndex > 0) {
          const [hintedNode] = poolCandidates.splice(hintIndex, 1);
          poolCandidates.unshift(hintedNode);
        }
      }

      // Intra-Pool Failover Loop: Iterate through sorted candidates in this pool
      for (const currentNode of poolCandidates) {
        triedNodeIds.add(currentNode.id);
        currentNode.activeRequests++;
        currentNode.lastUsedAt = new Date();

        const isCodegeneNode = (currentNode.url && (currentNode.url.includes("ai.codegene.io") || currentNode.url.includes("ollama.com"))) || (currentNode.name && currentNode.name.toLowerCase().includes("codegene"));
        const isCurrentGemini = !isCodegeneNode && (currentNode.format === "gemini" || currentNode.url.includes("googleapis.com"));
        const isCurrentGLM = !isCodegeneNode && (currentNode.format === "glm" || currentNode.url.includes("integrate.api.nvidia.com"));
        // For auto/best mode, use the node's defaultModel. For explicit model, use the requested model.
        // Keep :cloud suffix intact for cloud-hosted nodes (ollama.com / codegene proxy).
        let currentModel = (model && model !== "best" && model !== "auto" && !/^(gpt-4|gpt-3|claude)/i.test(model))
          ? model
          : (currentNode.defaultModel || (Array.isArray(currentNode.supportedModels) && currentNode.supportedModels[0]) || "glm-5.3-flash:cloud");
        if (isCurrentGemini && (!currentModel || currentModel === "best" || currentModel === "auto" || currentModel === "gemini-2.5-flash" || currentModel.includes("llama"))) {
          currentModel = currentNode.defaultModel && currentNode.defaultModel !== "gemini-2.5-flash" && !currentNode.defaultModel.includes("llama") ? currentNode.defaultModel : "gemini-3.5-flash-lite";
        }
        if (isCurrentGLM && (!currentModel || currentModel === "best" || currentModel === "auto" || currentModel === "llama3.2:3b" || currentModel.includes("llama"))) {
          currentModel = "z-ai/glm-5.2";
        }

        const nodeUrl = customUrl ? customUrl.trim().replace(/\/$/, "") : currentNode.url;
        const isOllamaNode = currentNode.format === "ollama" || (!currentNode.format && !currentNode.url.includes("openai.com") && !currentNode.url.includes("googleapis.com") && !currentNode.url.includes("nvidia.com"));
        const isCloudOrOpenAI = !isOllamaNode && (currentNode.format === "openai" || currentNode.format === "gemini" || currentNode.format === "glm" || currentNode.url.includes("googleapis.com") || currentNode.url.includes("openai.com") || currentNode.url.includes("integrate.api.nvidia.com"));

        let currentPath;
        if (isCurrentGemini) {
          currentPath = nodeUrl.endsWith("/openai") ? "/chat/completions" : "/v1/chat/completions";
        } else if (isCurrentGLM) {
          currentPath = nodeUrl.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
        } else if (isCloudOrOpenAI) {
          currentPath = "/v1/chat/completions";
        } else {
          currentPath = "/api/chat";
        }

        const isOfficialCloudService = currentNode.url.includes("api.openai.com") || currentNode.url.includes("googleapis.com") || currentNode.url.includes("integrate.api.nvidia.com");
        // Cloud-hosted proxy nodes (ollama.com, codegene) also need extended timeout - they do inference in cloud
        const isCloudHostedProxy = isCodegeneNode;

        // DB-only key resolution: use this node's own decrypted secretKey.
        // No process.env fallback — all keys must be set by admin via the dashboard.
        const resolvedApiKey = (currentNode.secretKey && !isKeyBlocked(currentNode.secretKey))
          ? currentNode.secretKey
          : currentNode.secretKey || ""; // Last resort: use own key even if blocked

        if (isOfficialCloudService && (!resolvedApiKey || !resolvedApiKey.trim())) {
          console.warn(`⚠️ [AI GATEWAY DISPATCH SKIPPED] Official cloud node ${currentNode.name} (${currentNode.format}) has no API Key configured. Add it via Admin Dashboard.`);
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
          continue;
        }

        // Skip this node if its key is currently blocked AND there are other non-blocked nodes available
        if (isOfficialCloudService && isKeyBlocked(currentNode.secretKey)) {
          const hasOtherAvailable = poolCandidates.some(n => n.id !== currentNode.id && !isKeyBlocked(n.secretKey || ""));
          if (hasOtherAvailable) {
            console.warn(`⏭️ [AI GATEWAY SKIP] Node ${currentNode.name} key is rate-limited (blocked). Skipping to next node with available key.`);
            currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
            continue;
          }
        }

        const nodeHeaders = { ...headers };
        if (resolvedApiKey) {
          nodeHeaders["Authorization"] = `Bearer ${resolvedApiKey}`;
          nodeHeaders["X-Internal-Secret"] = resolvedApiKey;
        }

        // Build final fetch URL from admin-configured node URL without duplicate /v1 paths
        let targetFetchUrl;
        const cleanNodeUrl = nodeUrl.replace(/\/+$/, "");
        if (isCodegeneNode) {
          targetFetchUrl = cleanNodeUrl.endsWith("/v1/chat/completions")
            ? cleanNodeUrl
            : cleanNodeUrl.endsWith("/v1")
            ? `${cleanNodeUrl}/chat/completions`
            : `${cleanNodeUrl}/v1/chat/completions`;
        } else if (isCurrentGemini) {
          if (cleanNodeUrl.includes("/chat/completions")) {
            targetFetchUrl = cleanNodeUrl;
          } else if (cleanNodeUrl.includes("/openai")) {
            targetFetchUrl = `${cleanNodeUrl}/chat/completions`;
          } else if (cleanNodeUrl.includes("googleapis.com")) {
            targetFetchUrl = `${cleanNodeUrl}/openai/chat/completions`;
          } else {
            targetFetchUrl = `${cleanNodeUrl}/v1/chat/completions`;
          }
        } else if (cleanNodeUrl.endsWith("/chat/completions") || cleanNodeUrl.endsWith("/api/chat")) {
          targetFetchUrl = cleanNodeUrl;
        } else if (cleanNodeUrl.endsWith("/v1")) {
          targetFetchUrl = `${cleanNodeUrl}/chat/completions`;
        } else if (isCloudOrOpenAI || isCurrentGLM) {
          targetFetchUrl = `${cleanNodeUrl}/v1/chat/completions`;
        } else {
          targetFetchUrl = `${cleanNodeUrl}/api/chat`;
        }

        registerActiveJob(activeJobId, {
          userId,
          userPriority,
          nodeId: currentNode.id,
          res,
          abortController
        });

        const imageAttachments = Array.isArray(attachments)
          ? attachments.filter(a => (a.fileType === "image" || a.mimeType?.startsWith("image/")) && a.data)
          : [];
        const cleanBase64List = imageAttachments.map(a => a.data.replace(/^data:.*?;base64,/, ""));

        // High Availability Model Fallback Tiers
        let modelsToTry;
        if (isCodegeneNode) {
          const codegeneVisionModels = ["glm-5.3-flash:cloud", "gemma4:cloud", "kimi-k2.7-code:cloud", "qwen3.5:2b-q4_K_M"];
          if (imageAttachments.length > 0) {
            // Prioritize models that support vision; deepseek-v4-flash:cloud does not support image input
            const chosenVisionModel = (currentModel && codegeneVisionModels.includes(currentModel)) ? currentModel : "glm-5.3-flash:cloud";
            modelsToTry = Array.from(new Set([
              chosenVisionModel,
              ...codegeneVisionModels,
              ...(Array.isArray(currentNode.supportedModels) ? currentNode.supportedModels.filter(m => m !== "deepseek-v4-flash:cloud") : [])
            ])).filter(Boolean);
          } else {
            modelsToTry = Array.from(new Set([
              currentModel,
              ...(Array.isArray(currentNode.supportedModels) ? currentNode.supportedModels : []),
              "deepseek-v4-flash:cloud",
              "glm-5.3-flash:cloud",
              "gemma4:cloud",
              "kimi-k2.7-code:cloud"
            ])).filter(Boolean);
          }
        } else if (isCurrentGemini) {
          modelsToTry = Array.from(new Set([
            (currentModel && currentModel.toLowerCase().includes("gemini") && currentModel !== "gemini-2.5-flash") ? currentModel : "gemini-3.5-flash-lite",
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash"
          ])).filter(Boolean);
        } else if (isCurrentGLM) {
          modelsToTry = Array.from(new Set([currentModel, "zhipuai/glm-4-flash", "meta/llama-3.1-8b-instruct"])).filter(Boolean);
        } else if (currentNode.format === "ollama" || isOllamaNode || !isOfficialCloudService) {
          const supported = Array.isArray(currentNode.supportedModels) ? currentNode.supportedModels : [];
          const validOllamaModels = supported
            .map(m => m.replace(/:cloud$/, ""))
            .filter(m => !m.toLowerCase().includes("gemini"));

          let primaryOllamaModel = (currentNode.defaultModel || "").replace(/:cloud$/, "");
          if (!primaryOllamaModel || primaryOllamaModel.toLowerCase().includes("gemini")) {
            primaryOllamaModel = validOllamaModels[0] || "glm-5.3-flash";
          }

          if (isExplicitModel) {
            modelsToTry = Array.from(new Set([currentModel, primaryOllamaModel, ...validOllamaModels].filter(Boolean)));
          } else {
            // Auto Mode: strictly try the primary active model and at most 1 backup
            const backupModel = validOllamaModels.find(m => m !== primaryOllamaModel) || "kimi-k2.6";
            modelsToTry = Array.from(new Set([primaryOllamaModel, backupModel].filter(Boolean)));
          }
        } else {
          modelsToTry = [currentModel];
        }

        let modelSuccess = false;

        // Provider-aware context payload selection:
        // Local Models: System Prompt + RAG + Recent Messages (NO Summary)
        // Cloud Models: System Prompt + RAG + Recent Messages + Rolling Summary
        const isLocal = isLocalNodeOrProvider(currentNode);
        let providerMessages = buildProviderAwareContextPayload({
          messages,
          conversationSummary,
          isLocal
        });

        // Gemini OpenAI compatibility endpoint obeys system instructions best when prepended to user prompt
        if (isCurrentGemini) {
          const sysMsg = providerMessages.find(m => m.role === "system");
          const userMsgs = providerMessages.filter(m => m.role !== "system");
          if (sysMsg && userMsgs.length > 0) {
            const sysContent = sysMsg.content;
            providerMessages = userMsgs.map((m, idx) => {
              if (idx === 0 && m.role === "user") {
                return { role: "user", content: `Instruction: ${sysContent}\n\nUser Question: ${m.content}` };
              }
              return { role: m.role, content: m.content };
            });
          }
        }

        // Format multimodal messages according to endpoint specifications
        let formattedMessages = providerMessages;
        if (imageAttachments.length > 0) {
          let lastUserIndex = -1;
          for (let i = formattedMessages.length - 1; i >= 0; i--) {
            if (formattedMessages[i].role === "user") {
              lastUserIndex = i;
              break;
            }
          }

          if (lastUserIndex !== -1) {
            formattedMessages = formattedMessages.map((m, idx) => {
              if (idx !== lastUserIndex) return m;

              const textContent = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? (m.content.find(c => c.type === "text")?.text || "") : "");
              const promptText = textContent && textContent.trim() ? textContent : "Please analyze this image and describe what it contains.";

              // If native Ollama endpoint (/api/chat), Ollama expects message.images = [base64]
              if (targetFetchUrl.endsWith("/api/chat")) {
                return {
                  ...m,
                  content: promptText,
                  images: cleanBase64List
                };
              }

              // For OpenAI-compatible endpoints (including /v1/chat/completions on Ollama, Gemini OpenAI endpoint, vLLM):
              // Standard OpenAI Vision format requires content to be an array of { type: 'text' } and { type: 'image_url' }
              const contentParts = [
                { type: "text", text: promptText },
                ...imageAttachments.map(att => {
                  const mime = att.mimeType || "image/png";
                  const cleanB64 = att.data.replace(/^data:.*?;base64,/, "");
                  return {
                    type: "image_url",
                    image_url: {
                      url: `data:${mime};base64,${cleanB64}`
                    }
                  };
                })
              ];

              return {
                ...m,
                content: contentParts,
                images: cleanBase64List // Retain for hybrid servers
              };
            });
          }
        }

        const providerTag = isCurrentGemini ? "GEMINI" : (currentNode.format ? currentNode.format.toUpperCase() : "OLLAMA");

        for (const candidateModel of modelsToTry) {
          const payload = { model: candidateModel, messages: formattedMessages, stream: true };
          if (cleanBase64List.length > 0 && targetFetchUrl.endsWith("/api/chat")) {
            payload.images = cleanBase64List;
          }
          if (maxTokens) {
            payload.max_tokens = Number(maxTokens);
          }
          if (currentNode.format === "ollama" && !isCodegeneNode) payload.keep_alive = "24h";

          const dispatchStartTime = performance.now();

          try {
            console.log(`\n================================================================================`);
            console.log(`📤 [AI REQUEST -> ${providerTag}]`);
            console.log(`  • JobId:       ${activeJobId}`);
            console.log(`  • Provider:    ${currentNode.format || "ollama"}`);
            console.log(`  • Node Name:   ${currentNode.name} (${currentNode.id})`);
            console.log(`  • Target URL:  ${targetFetchUrl}`);
            console.log(`  • Model:       ${candidateModel}`);
            console.log(`  • Priority:    ${currentNode.priorityScore}`);
            console.log(`  • Headers:     ${JSON.stringify({
              "Content-Type": nodeHeaders["Content-Type"],
              "Authorization": nodeHeaders["Authorization"] ? (nodeHeaders["Authorization"].substring(0, 15) + "...") : "None",
              "User-Agent": nodeHeaders["User-Agent"]
            })}`);
            console.log(`  • Payload:`);
            console.log(JSON.stringify(payload, null, 2));
            console.log(`================================================================================\n`);

            response = await safeFetch(targetFetchUrl, {
              method: "POST",
              headers: nodeHeaders,
              body: JSON.stringify(payload),
              signal: abortController.signal,
              // Cloud providers (NVIDIA, Gemini, OpenAI) need longer timeout for inference
              // Cloud proxy nodes (ollama.com, codegene) need 90s - models do chain-of-thought reasoning
              // Local Ollama nodes keep the default 25s
              timeout: isOfficialCloudService ? 60000 : (isCloudHostedProxy ? 90000 : undefined)
            });

            const elapsedMs = (performance.now() - dispatchStartTime).toFixed(2);

            if (response.ok) {
              const rawStream = response.rawStream;
              if (rawStream) {
                const streamBuffer = new ActionStreamBuffer(res, onToken);
                let lineBuffer = "";

                await new Promise((resolveStream) => {
                  const parseLine = (line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === "event: chunk" || trimmed === "event: metadata" || trimmed.startsWith(":")) return;
                    let jsonStr = trimmed;
                    if (trimmed.startsWith("data:")) {
                      jsonStr = trimmed.replace(/^data:\s*/, "").trim();
                    }
                    if (!jsonStr || jsonStr === "[DONE]") return;
                    try {
                      const parsed = JSON.parse(jsonStr);
                      const delta = parsed.choices?.[0]?.delta;
                      // Only extract user-facing content. Internal reasoning tokens (delta.reasoning) are internal CoT and must NOT be outputted as the message text!
                      let chunkText = "";
                      if (delta && typeof delta.content === "string") {
                        chunkText = delta.content;
                      } else if (typeof parsed.choices?.[0]?.message?.content === "string") {
                        chunkText = parsed.choices[0].message.content;
                      } else if (typeof parsed.message?.content === "string") {
                        chunkText = parsed.message.content;
                      } else if (typeof parsed.response === "string") {
                        chunkText = parsed.response;
                      }

                      if (chunkText) {
                        if (!firstTokenTimestamp) {
                          firstTokenTimestamp = performance.now();
                          ttft = firstTokenTimestamp - llmStartTime;
                        }
                        streamBuffer.push(chunkText);
                      }
                    } catch (e) { }
                  };

                  rawStream.on("data", (chunk) => {
                    lineBuffer += chunk.toString("utf8");
                    let idx;
                    while ((idx = lineBuffer.indexOf("\n")) !== -1) {
                      const line = lineBuffer.substring(0, idx);
                      lineBuffer = lineBuffer.substring(idx + 1);
                      parseLine(line);
                    }
                  });

                  rawStream.on("end", () => {
                    if (lineBuffer.trim()) parseLine(lineBuffer);
                    resolveStream();
                  });

                  rawStream.on("error", (err) => {
                    console.warn(`⚠️ [AI GATEWAY STREAM ERROR] ${err.message}`);
                    resolveStream();
                  });

                  if (abortController.signal.aborted) {
                    rawStream.destroy();
                    resolveStream();
                  } else {
                    abortController.signal.addEventListener("abort", () => rawStream.destroy(), { once: true });
                  }
                });

                streamBuffer.flush();

                if (streamBuffer.cleanText && streamBuffer.cleanText.trim().length > 0) {
                  accumulatedResponseText = streamBuffer.cleanText;
                  selectedNode = currentNode;
                  selectedModel = candidateModel;
                  currentNode.successRequests = (currentNode.successRequests || 0) + 1;
                  currentNode.consecutiveFailures = 0;
                  currentNode.status = "ACTIVE";
                  modelSuccess = true;
                  streamedSuccessfully = true;

                  console.log(`\n================================================================================`);
                  console.log(`📥 [AI RESPONSE <- ${providerTag}]`);
                  console.log(`  • JobId:         ${activeJobId}`);
                  console.log(`  • Provider:      ${currentNode.format || "ollama"}`);
                  console.log(`  • Node Name:     ${currentNode.name}`);
                  console.log(`  • Model:         ${candidateModel}`);
                  console.log(`  • HTTP Status:   ${response.status} OK`);
                  console.log(`  • Latency:       ${elapsedMs} ms`);
                  console.log(`  • TTFT:          ${ttft > 0 ? ttft.toFixed(2) + " ms" : "N/A"}`);
                  console.log(`  • Response Text:`);
                  console.log(accumulatedResponseText);
                  console.log(`================================================================================\n`);

                  if (currentNode.id && currentNode.id.length === 24) {
                    ServerNode.findByIdAndUpdate(currentNode.id, {
                      $inc: { successRequests: 1 },
                      status: "ACTIVE",
                      consecutiveFailures: 0,
                      defaultModel: candidateModel,
                      lastUsedAt: new Date()
                    }).catch(err => console.error("Notice: ServerNode update failed:", err.message || err));
                  }

                  break; // Successful token streaming! Exit candidate model loop
                } else {
                  console.warn(`\n⚠️ [AI EMPTY RESPONSE <- ${providerTag}] Model '${candidateModel}' on ${currentNode.name} returned 0 tokens. Trying next candidate model...\n`);
                }
              }
            } else {
              const errorBody = await readStreamBody(response.rawStream);
              console.error(`\n================================================================================`);
              console.error(`❌ [AI ERROR RESPONSE <- ${providerTag}]`);
              console.error(`  • JobId:       ${activeJobId}`);
              console.error(`  • Provider:    ${currentNode.format || "ollama"}`);
              console.error(`  • Node Name:   ${currentNode.name}`);
              console.error(`  • Model:       ${candidateModel}`);
              console.error(`  • HTTP Status: ${response.status}`);
              console.error(`  • Latency:     ${elapsedMs} ms`);
              console.error(`  • Error Body:`);
              console.error(errorBody || "(empty body)");
              console.error(`================================================================================\n`);

              if (response.status === 429) {
                if (resolvedApiKey) blockKey(resolvedApiKey, 90000);
                console.warn(`⚠️ [AI GATEWAY NODE RATE_LIMIT] Node '${currentNode.name}' hit HTTP 429. Key blocked 90s. Moving to next cluster node...`);
                errorMessage = `Provider API Rate Limit Exceeded (HTTP 429) on ${currentNode.name}. ${errorBody}`.trim();
                currentNode.status = "RATE_LIMITED";
                currentNode.retryAfter = new Date(Date.now() + 90 * 1000);
                if (currentNode.id && currentNode.id.length === 24) {
                  ServerNode.findByIdAndUpdate(currentNode.id, {
                    status: "RATE_LIMITED",
                    retryAfter: currentNode.retryAfter,
                    errorMessage: "Session rate limit exceeded (HTTP 429)"
                  }).catch(err => console.error("Notice: ServerNode rate limit update failed:", err.message || err));
                }
                break;
              } else if (response.status === 400 && errorBody.includes("does not support image input")) {
                console.warn(`⚠️ [AI GATEWAY VISION NOTICE] Model '${candidateModel}' on node '${currentNode.name}' does not support image input. Trying next candidate model on this node...`);
                errorMessage = `Model ${candidateModel} does not support image input.`;
                continue;
              } else if (response.status === 401 || response.status === 403) {
                console.warn(`⚠️ [AI GATEWAY AUTH NOTICE] Node '${currentNode.name}' returned HTTP ${response.status} (Auth Error). Skipping to next active cluster node...`);
                errorMessage = `Authentication rejected on ${currentNode.name} (HTTP ${response.status}). ${errorBody}`.trim();
                break; // Fast failover: do not retry with other models on this node
              } else if (response.status === 404 || response.status === 410) {
                console.warn(`⚠️ [AI GATEWAY MODEL NOTICE] Model '${candidateModel}' on ${currentNode.name} returned HTTP ${response.status}. Auto-removing from supportedModels...`);
                errorMessage = `Model ${candidateModel} returned HTTP ${response.status}. ${errorBody}`.trim();
                // Auto-purge: remove this 404'd model from DB so it's never tried again
                if (currentNode.id && currentNode.id.length === 24) {
                  const updatedSupported = (Array.isArray(currentNode.supportedModels) ? currentNode.supportedModels : [])
                    .filter(m => m !== candidateModel && m.replace(/:cloud$/, "") !== candidateModel.replace(/:cloud$/, ""));
                  const newDefault = (currentNode.defaultModel === candidateModel || currentNode.defaultModel === candidateModel.replace(/:cloud$/, ""))
                    ? (updatedSupported[0] || "glm-5.3-flash:cloud")
                    : currentNode.defaultModel;
                  currentNode.supportedModels = updatedSupported;
                  if (currentNode.defaultModel !== newDefault) currentNode.defaultModel = newDefault;
                  ServerNode.findByIdAndUpdate(currentNode.id, {
                    supportedModels: updatedSupported,
                    defaultModel: newDefault
                  }).catch(err => console.error("Notice: ServerNode model purge update failed:", err.message || err));
                  console.warn(`  🗑️ [MODEL PURGED] Removed '${candidateModel}' from node '${currentNode.name}'. New defaultModel: ${currentNode.defaultModel}`);
                }
              } else {
                errorMessage = `Server Node ${currentNode.name} returned HTTP ${response.status}. ${errorBody}`.trim();
              }
            }
          } catch (err) {
            console.error(`\n================================================================================`);
            console.error(`❌ [AI NETWORK ERROR -> ${providerTag}]`);
            console.error(`  • JobId:       ${activeJobId}`);
            console.error(`  • Node Name:   ${currentNode.name} (${targetFetchUrl})`);
            console.error(`  • Model:       ${candidateModel}`);
            console.error(`  • Error:       ${err.message}`);
            console.error(`================================================================================\n`);
            errorMessage = `Network connection error on ${currentNode.name}: ${err.message}`;
            console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${currentNode.name} network error: ${err.message}.`);
          }
        }

        if (modelSuccess) {
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
          break; // Intra-Pool Success! Exit node loop
        } else {
          currentNode.failedRequests = (currentNode.failedRequests || 0) + 1;
          currentNode.consecutiveFailures = (currentNode.consecutiveFailures || 0) + 1;

          if (currentNode.id && currentNode.id.length === 24) {
            ServerNode.findByIdAndUpdate(currentNode.id, {
              $inc: { failedRequests: 1, consecutiveFailures: 1 },
              status: currentNode.status,
              retryAfter: currentNode.retryAfter,
              errorMessage
            }).catch(err => console.error("Notice: ServerNode failure count update failed:", err.message || err));
          }
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
        }
      }
    }
    } finally {
      unregisterActiveJob(activeJobId);
      if (selectedNode) {
        selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);
      }
    }

    if (!accumulatedResponseText || !accumulatedResponseText.trim()) {
      const hasImage = Array.isArray(attachments) && attachments.some(a => (a.fileType === "image" || a.mimeType?.startsWith("image/")) && a.data);
      if (isGeminiModel || hasImage || !isExplicitModel) {
        try {
          console.log(`🔄 [VISION / GEMINI FALLBACK] Attempting Cloud Gemini fallback (gemini-3.5-flash-lite)...`);
          const cloudRes = await this._streamCloudGemini({ model: "gemini-3.5-flash-lite", messages, attachments, conversationSummary, res, onToken });
          if (cloudRes && cloudRes.text) {
            accumulatedResponseText = cloudRes.text;
            streamedSuccessfully = true;
          }
        } catch (fErr) {
          console.warn("⚠️ [GATEWAY AUTO] Direct Gemini retry notice:", fErr.message);
        }
      }
      if (!accumulatedResponseText && (isGLMModel || !isExplicitModel)) {
        try {
          const cloudRes = await this._streamCloudGLM({ model: "z-ai/glm-5.2", messages, conversationSummary, res, onToken });
          if (cloudRes && cloudRes.text) {
            accumulatedResponseText = cloudRes.text;
            streamedSuccessfully = true;
          }
        } catch (fErr) {
          console.warn("⚠️ [GATEWAY AUTO] Direct GLM retry notice:", fErr.message);
        }
      }
      if (!accumulatedResponseText && (isOpenAIModel || !isExplicitModel)) {
        try {
          const cloudRes = await this._streamCloudOpenAI({ model: "gpt-4o-mini", messages, conversationSummary, res, onToken });
          if (cloudRes && cloudRes.text) {
            accumulatedResponseText = cloudRes.text;
            streamedSuccessfully = true;
          }
        } catch (fErr) {
          console.warn("⚠️ [GATEWAY AUTO] Direct OpenAI retry notice:", fErr.message);
        }
      }
    }

    const totalDurationMs = performance.now() - llmStartTime;
    const promptTokens = estimateTokens(messages);
    const completionTokens = estimateTokens(accumulatedResponseText);

    return {
      success: streamedSuccessfully && accumulatedResponseText.trim().length > 0,
      text: accumulatedResponseText,
      errorMessage,
      userFriendlyMessage: sanitizeUserFacingError(errorMessage),
      ttft,
      totalDurationMs,
      nodeId: selectedNode ? selectedNode.id : "unknown",
      nodeName: selectedNode ? selectedNode.name : "",
      model: selectedModel || (selectedNode && selectedNode.defaultModel) || "auto",
      provider: selectedNode ? (selectedNode.format || "ollama") : "auto",
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  /**
   * Cloud OpenAI Stream Fallback Implementation
   */
  async _streamCloudOpenAI({ model, messages, conversationSummary = null, res, onToken }) {
    // DB-only key resolution: collect all active OpenAI node keys from MongoDB.
    // No process.env.OPENAI_API_KEY fallback — admin manages all keys via dashboard.
    const { clusterState } = require("./ollamaHelper");
    const { decrypt } = require("./encryption");

    const memKeys = clusterState
      .filter(n => n.url && n.url.includes("api.openai.com"))
      .map(n => n.secretKey)
      .filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k) && !k.startsWith("sk-ollam"));

    let dbKeys = [];
    try {
      const ServerNode = require("../models/ServerNode");
      const dbNodes = await ServerNode.find({
        url: /api\.openai\.com/i,
        isActive: true,
        secretKey: { $exists: true, $ne: "" }
      });
      dbKeys = dbNodes.map(n => {
        try { return n.secretKey ? decrypt(n.secretKey) : ""; } catch (e) { return n.secretKey || ""; }
      }).filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k) && !k.startsWith("sk-ollam"));
    } catch (e) {}

    const apiKey = [...new Set([...memKeys, ...dbKeys])].find(k => !isKeyBlocked(k)) || null;

    if (!apiKey) {
      throw new Error("No OpenAI API key found. Please add an OpenAI Server Node with a valid sk- key in the Admin Dashboard.");
    }

    const providerMessages = buildProviderAwareContextPayload({
      messages,
      conversationSummary,
      isLocal: false
    });

    const openAiStartTime = performance.now();
    console.log(`\n================================================================================`);
    console.log(`📤 [AI REQUEST -> OPENAI (CLOUD SDK)]`);
    console.log(`  • Model:    ${model || "gpt-4o-mini"}`);
    console.log(`  • Messages:`);
    console.log(JSON.stringify(providerMessages, null, 2));
    console.log(`================================================================================\n`);

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey });
    const stream = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages: providerMessages,
      stream: true
    });

    const streamBuffer = new ActionStreamBuffer(res, onToken);
    for await (const chunk of stream) {
      const chunkText = chunk.choices[0]?.delta?.content || "";
      if (chunkText) {
        streamBuffer.push(chunkText);
      }
    }
    streamBuffer.flush();

    const openAiElapsedMs = (performance.now() - openAiStartTime).toFixed(2);
    console.log(`\n================================================================================`);
    console.log(`📥 [AI RESPONSE <- OPENAI (CLOUD SDK)]`);
    console.log(`  • Model:         ${model || "gpt-4o-mini"}`);
    console.log(`  • Latency:       ${openAiElapsedMs} ms`);
    console.log(`  • Response Text:`);
    console.log(streamBuffer.cleanText);
    console.log(`================================================================================\n`);

    const promptTokens = estimateTokens(messages);
    const completionTokens = estimateTokens(streamBuffer.cleanText);

    return {
      success: true,
      text: streamBuffer.cleanText,
      nodeId: "cloud_openai",
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  /**
   * Cloud Google Gemini Stream Fallback Implementation
   */
  async _streamCloudGemini({ model, messages = [], attachments = [], conversationSummary = null, res, onToken, secretKey = null }) {
    // DB-only key resolution: collect all active Gemini node keys from MongoDB.
    // No process.env.GEMINI_API_KEY fallback — admin manages all keys via dashboard.
    const { clusterState } = require("./ollamaHelper");
    const { decrypt } = require("./encryption");

    // Build candidate keys: start from in-memory clusterState (already decrypted),
    // then fall back to a fresh DB query for any nodes not yet in memory.
    const memKeys = clusterState
      .filter(n => n.format === "gemini" || n.url.includes("googleapis.com"))
      .map(n => n.secretKey)
      .filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k));

    let dbKeys = [];
    try {
      const ServerNode = require("../models/ServerNode");
      const dbNodes = await ServerNode.find({
        $or: [{ format: "gemini" }, { url: /googleapis\.com/i }],
        isActive: true,
        secretKey: { $exists: true, $ne: "" }
      });
      dbKeys = dbNodes.map(n => {
        try { return n.secretKey ? decrypt(n.secretKey) : ""; } catch (e) { return n.secretKey || ""; }
      }).filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k));
    } catch (e) {}

    // Merge, deduplicate, honour optional override key passed in
    const candidateApiKeys = [...new Set([
      ...(secretKey ? [secretKey] : []),
      ...memKeys,
      ...dbKeys
    ])];

    if (candidateApiKeys.length === 0) {
      throw new Error("No Gemini API key found. Please add a Gemini Server Node with a valid API key in the Admin Dashboard.");
    }

    const requestedModel = (model && model !== "best" && model !== "auto") ? model : "gemini-3.5-flash-lite";
    const primaryModel = requestedModel === "gemini-2.5-flash" ? "gemini-3.5-flash-lite" : requestedModel;
    const candidateModels = Array.from(new Set([
      primaryModel,
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-flash-lite-latest",
      "gemini-flash-latest"
    ])).filter(Boolean);
    const { GoogleGenAI } = require("@google/genai");

    for (const gKey of candidateApiKeys) {
      // Skip keys that are currently rate-limited
      if (isKeyBlocked(gKey)) {
        const maskedKey = gKey.length > 10 ? `...${gKey.slice(-6)}` : gKey;
        console.warn(`⏭️ [CLOUD GEMINI] Skipping blocked key ${maskedKey}. Trying next key...`);
        continue;
      }

      const streamBuffer = new ActionStreamBuffer(res, onToken);
      let keySucceeded = false;

      for (const gModel of candidateModels) {
        const geminiStartTime = performance.now();
        try {
          const sysMsg = messages.find(m => m.role === "system")?.content || "";
          const userMsgs = messages.filter(m => m.role !== "system");

          const contentsPayload = userMsgs.map((m, idx) => {
            const isLastUserMsg = idx === userMsgs.length - 1 && m.role === "user";
            const parts = [{ text: m.content || "" }];

            if (isLastUserMsg && Array.isArray(attachments)) {
              attachments.forEach(att => {
                if ((att.fileType === "image" || att.mimeType?.startsWith("image/")) && att.data) {
                  parts.push({
                    inlineData: {
                      mimeType: att.mimeType || "image/png",
                      data: att.data
                    }
                  });
                } else if ((att.fileType === "pdf" || att.mimeType === "application/pdf") && att.data) {
                  parts.push({
                    inlineData: {
                      mimeType: "application/pdf",
                      data: att.data
                    }
                  });
                }
              });
            }

            return {
              role: m.role === "assistant" ? "model" : "user",
              parts
            };
          });

          if (contentsPayload.length === 0) {
            const userMsg = [...messages].reverse().find(m => m.role === "user")?.content || "Hello";
            contentsPayload.push({ role: "user", parts: [{ text: userMsg }] });
          }

          const maskedKey = gKey.length > 10 ? `${gKey.slice(0, 6)}...${gKey.slice(-4)}` : "***";
          const geminiStartTime = performance.now();

          console.log(`\n================================================================================`);
          console.log(`📤 [AI REQUEST -> GOOGLE GEMINI (CLOUD SDK)]`);
          console.log(`  • Model:          ${gModel}`);
          console.log(`  • API Key:        ${maskedKey}`);
          console.log(`  • System Prompt:  ${sysMsg || "(none)"}`);
          console.log(`  • Messages Count: ${contentsPayload.length}`);
          console.log(`  • Contents Payload:`);
          console.log(JSON.stringify(contentsPayload, null, 2));
          console.log(`================================================================================\n`);

          const ai = new GoogleGenAI({ apiKey: gKey });
          const responseStream = await ai.models.generateContentStream({
            model: gModel,
            contents: contentsPayload,
            config: {
              ...(sysMsg ? { systemInstruction: sysMsg } : {}),
              ...(gModel.includes("lite") ? {} : { thinkingConfig: { thinkingBudget: 0 } })
            }
          });

          for await (const chunk of responseStream) {
            const chunkText = chunk.text || "";
            if (chunkText) streamBuffer.push(chunkText);
          }
          streamBuffer.flush();

          if (streamBuffer.cleanText && streamBuffer.cleanText.trim()) {
            keySucceeded = true;
            const geminiElapsedMs = (performance.now() - geminiStartTime).toFixed(2);

            console.log(`\n================================================================================`);
            console.log(`📥 [AI RESPONSE <- GOOGLE GEMINI (CLOUD SDK)]`);
            console.log(`  • Model:         ${gModel}`);
            console.log(`  • Latency:       ${geminiElapsedMs} ms`);
            console.log(`  • Response Text:`);
            console.log(streamBuffer.cleanText);
            console.log(`================================================================================\n`);

            const promptTokens = estimateTokens(messages);
            const completionTokens = estimateTokens(streamBuffer.cleanText);
            return {
              success: true,
              text: streamBuffer.cleanText,
              nodeId: "cloud_gemini",
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens
            };
          }
        } catch (apiErr) {
          const geminiElapsedMs = (performance.now() - geminiStartTime).toFixed(2);
          const errStatus = apiErr.status || apiErr.response?.status;

          console.error(`\n================================================================================`);
          console.error(`❌ [AI ERROR RESPONSE <- GOOGLE GEMINI (CLOUD SDK)]`);
          console.error(`  • Model:    ${gModel}`);
          console.error(`  • Status:   ${errStatus || "Error"}`);
          console.error(`  • Latency:  ${geminiElapsedMs} ms`);
          console.error(`  • Error:    ${apiErr.message || apiErr}`);
          if (apiErr.response?.data) {
            console.error(`  • Error Details:`, JSON.stringify(apiErr.response.data, null, 2));
          }
          console.error(`================================================================================\n`);

          if (errStatus === 429 || apiErr.message?.includes("429") || apiErr.message?.includes("quota")) {
            // Block this specific key and break model loop to try next key
            blockKey(gKey, 90000);
            console.warn(`⚠️ [CLOUD GEMINI RATE LIMIT] Key ...${gKey.slice(-6)} hit quota. Blocked 90s. Trying next key...`);
            break; // exits candidateModels loop → continues to next gKey
          } else if (errStatus === 401 || apiErr.message?.includes("401")) {
            blockKey(gKey, 300000); // 5 min for auth failures
            console.warn(`⚠️ [CLOUD GEMINI AUTH FAIL] Key ...${gKey.slice(-6)} is invalid. Blocked 5min. Trying next key...`);
            break;
          } else {
            console.warn(`Gemini cloud model ${gModel} error:`, apiErr.message || apiErr);
          }
        }
      }

      if (keySucceeded) break;
    }

    return { success: false, text: "" };
  }

  /**
   * Cloud NVIDIA GLM Stream Implementation
   */
  async _streamCloudGLM({ model, messages, conversationSummary = null, res, onToken, secretKey = null }) {
    // DB-only key resolution: collect all active GLM node keys from MongoDB.
    // No process.env.NVIDIA_API_KEY fallback — admin manages all keys via dashboard.
    const { clusterState } = require("./ollamaHelper");
    const { decrypt } = require("./encryption");

    const memKeys = clusterState
      .filter(n => n.format === "glm" || n.url.includes("integrate.api.nvidia.com"))
      .map(n => n.secretKey)
      .filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k));

    let dbKeys = [];
    try {
      const ServerNode = require("../models/ServerNode");
      const dbNodes = await ServerNode.find({
        $or: [{ format: "glm" }, { url: /nvidia\.com/i }],
        isActive: true,
        secretKey: { $exists: true, $ne: "" }
      });
      dbKeys = dbNodes.map(n => {
        try { return n.secretKey ? decrypt(n.secretKey) : ""; } catch (e) { return n.secretKey || ""; }
      }).filter(k => k && k.length > 10 && !/[\u2022\*]/.test(k));
    } catch (e) {}

    const candidateApiKeys = [...new Set([
      ...(secretKey ? [secretKey] : []),
      ...memKeys,
      ...dbKeys
    ])];

    // Try each non-blocked key
    let apiKey = candidateApiKeys.find(k => !isKeyBlocked(k)) || candidateApiKeys[0] || null;

    if (!apiKey) {
      throw new Error("No NVIDIA GLM API key found. Please add a GLM Server Node with a valid nvapi- key in the Admin Dashboard.");
    }

    const providerMessages = buildProviderAwareContextPayload({
      messages,
      conversationSummary,
      isLocal: false
    });

    const glmStartTime = performance.now();
    console.log(`\n================================================================================`);
    console.log(`📤 [AI REQUEST -> NVIDIA GLM (CLOUD SDK)]`);
    console.log(`  • Model:    ${model || "z-ai/glm-5.2"}`);
    console.log(`  • Messages:`);
    console.log(JSON.stringify(providerMessages, null, 2));
    console.log(`================================================================================\n`);

    const { OpenAI } = require("openai");
    const nvidia = new OpenAI({
      apiKey,
      baseURL: "https://integrate.api.nvidia.com/v1"
    });

    const stream = await nvidia.chat.completions.create({
      model: model || "z-ai/glm-5.2",
      messages: providerMessages,
      stream: true
    });

    const streamBuffer = new ActionStreamBuffer(res, onToken);
    for await (const chunk of stream) {
      const chunkText = chunk.choices[0]?.delta?.content || "";
      if (chunkText) {
        streamBuffer.push(chunkText);
      }
    }
    streamBuffer.flush();

    const glmElapsedMs = (performance.now() - glmStartTime).toFixed(2);
    console.log(`\n================================================================================`);
    console.log(`📥 [AI RESPONSE <- NVIDIA GLM (CLOUD SDK)]`);
    console.log(`  • Model:         ${model || "z-ai/glm-5.2"}`);
    console.log(`  • Latency:       ${glmElapsedMs} ms`);
    console.log(`  • Response Text:`);
    console.log(streamBuffer.cleanText);
    console.log(`================================================================================\n`);

    const promptTokens = estimateTokens(messages);
    const completionTokens = estimateTokens(streamBuffer.cleanText);

    return {
      success: true,
      text: streamBuffer.cleanText,
      nodeId: "cloud_glm",
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }
}

/**
 * Helper to parse ACTION directives from LLM output lines
 * e.g., ACTION: responseType=live_agent liveAgent=true
 */
function parseActionDirective(line) {
  if (!line || typeof line !== "string") return null;
  const trimmed = line.trim();
  const match = trimmed.match(/^\[?\s*ACTION\s*:\s*(.+)\]?$/i);
  if (!match) return null;

  const rawParams = match[1].replace(/\]$/, "").trim();
  const metadata = { type: "meta" };

  const pairs = rawParams.split(/\s+/);
  pairs.forEach(pair => {
    const [key, val] = pair.split("=");
    if (key) {
      let cleanVal = val ? val.trim().replace(/^["']|["']$/g, "") : true;
      if (cleanVal === "true") cleanVal = true;
      if (cleanVal === "false") cleanVal = false;
      metadata[key.trim()] = cleanVal;
    }
  });

  return metadata;
}

class ActionStreamBuffer {
  constructor(res, onToken) {
    this.res = res;
    this.onToken = onToken;
    this.cleanText = "";
    this.extractedMeta = [];
    this.firstTokenFired = false;
    this.inThinkBlock = false;
  }

  push(chunkText) {
    if (!chunkText) return;

    // Filter out <think> ... </think> reasoning tags if emitted in content
    if (chunkText.includes("<think>")) {
      this.inThinkBlock = true;
      chunkText = chunkText.replace(/<think>[\s\S]*?(<\/think>|$)/, "");
    } else if (this.inThinkBlock) {
      if (chunkText.includes("</think>")) {
        this.inThinkBlock = false;
        chunkText = chunkText.replace(/[\s\S]*?<\/think>/, "");
      } else {
        return; // Suppress reasoning tokens inside <think>
      }
    }
    if (!chunkText) return;

    const sanitizedChunk = this._sanitizeVendorBranding(chunkText);
    this.cleanText += sanitizedChunk;

    if (typeof this.onToken === "function") {
      this.onToken(sanitizedChunk);
    }
    this.firstTokenFired = true;

    if (this.res && !this.res.writableEnded) {
      this.res.write(`data: ${JSON.stringify({ type: "chunk", chunk: sanitizedChunk, text: sanitizedChunk })}\n\n`);
      if (typeof this.res.flush === "function") {
        try { this.res.flush(); } catch (e) {}
      }
    }
  }

  flush() {
    // All token chunks are already streamed immediately to client
  }

  _sanitizeVendorBranding(text) {
    if (!text || typeof text !== "string") return text;
    return text
      .replace(/\bChatGPT\b/gi, "AI Assistant")
      .replace(/\bOpenAI\b/gi, "AI Platform")
      .replace(/\b(Google Gemini|Gemini AI|Google's Gemini|Gemini)\b/gi, "AI Assistant")
      .replace(/\bOllama\b/gi, "AI Engine")
      .replace(/\bClaude\b/gi, "AI Assistant")
      .replace(/\bAnthropic\b/gi, "AI Platform");
  }
}

const modelPricingCache = new Map();
const MODEL_PRICING_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

async function getModelPricingCached(modelId) {
  if (!modelId || modelId === "auto" || modelId === "best") {
    return { promptTokenCostPer1k: 0.05, completionTokenCostPer1k: 0.1, displayName: "Auto", provider: "auto", modelId: "auto" };
  }
  const cached = modelPricingCache.get(modelId);
  if (cached && (Date.now() - cached.cachedAt < MODEL_PRICING_TTL_MS)) {
    return cached.data;
  }
  try {
    const AIModel = require("../models/AIModel");
    const modelDoc = await AIModel.findOne({ modelId, enabled: true });
    const data = modelDoc ? {
      modelId: modelDoc.modelId,
      displayName: modelDoc.displayName || modelDoc.modelId,
      provider: modelDoc.provider || "auto",
      promptTokenCostPer1k: modelDoc.promptTokenCostPer1k ?? 0.05,
      completionTokenCostPer1k: modelDoc.completionTokenCostPer1k ?? 0.1
    } : {
      modelId,
      displayName: modelId,
      provider: "auto",
      promptTokenCostPer1k: 0.05,
      completionTokenCostPer1k: 0.1
    };
    modelPricingCache.set(modelId, { data, cachedAt: Date.now() });
    return data;
  } catch (err) {
    return { promptTokenCostPer1k: 0.05, completionTokenCostPer1k: 0.1, displayName: modelId, provider: "auto", modelId };
  }
}

function invalidateModelPricingCache(modelId = null) {
  if (modelId) modelPricingCache.delete(modelId);
  else modelPricingCache.clear();
}

const gatewayInstance = new AIGateway();
gatewayInstance.getModelPricingCached = getModelPricingCached;
gatewayInstance.invalidateModelPricingCache = invalidateModelPricingCache;
gatewayInstance.sanitizeUserFacingError = sanitizeUserFacingError;

module.exports = gatewayInstance;
module.exports.sanitizeUserFacingError = sanitizeUserFacingError;

