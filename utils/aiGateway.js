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

// Global API Key Pool Index Trackers for Cloud Providers (Gemini, GLM/NVIDIA, OpenAI)
const keyPoolIndexes = {
  gemini: 0,
  glm: 0,
  openai: 0
};

/**
 * Gets next active API key for a provider from environment pool or node configuration
 */
function getProviderApiKey(provider, fallbackNodeKey) {
  let keysEnv = "";
  if (provider === "gemini") keysEnv = process.env.GEMINI_API_KEY || "";
  else if (provider === "glm") keysEnv = process.env.NVIDIA_API_KEY || "";
  else if (provider === "openai") keysEnv = process.env.OPENAI_API_KEY || "";

  const keys = [
    ...(fallbackNodeKey && typeof fallbackNodeKey === "string" && !/[\u2022\*]/.test(fallbackNodeKey) ? [fallbackNodeKey] : []),
    ...keysEnv.split(",").map(k => k.trim())
  ].filter(k => k && k.length > 5 && !/[\u2022\*]/.test(k));

  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return fallbackNodeKey || "";

  const currentIdx = (keyPoolIndexes[provider] || 0) % uniqueKeys.length;
  return uniqueKeys[currentIdx];
}

/**
 * Rotates API key index for a provider upon 429 Rate Limit or 401 Auth Failure
 */
function rotateProviderApiKey(provider) {
  if (typeof keyPoolIndexes[provider] !== "number") keyPoolIndexes[provider] = 0;
  keyPoolIndexes[provider]++;
  console.warn(`🔄 [API KEY ROTATED] Rotated ${provider.toUpperCase()} API key pool to key index #${keyPoolIndexes[provider]}`);
}

function safeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const client = isHttps ? https : http;

      const reqHeaders = { ...(options.headers || {}) };
      if (!reqHeaders["User-Agent"]) {
        reqHeaders["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
      }

      if (options.body && !reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = Buffer.byteLength(options.body);
      }

      const reqOptions = {
        method: options.method || "GET",
        headers: reqHeaders,
        agent: isHttps ? httpsAgent : httpAgent
      };

      const req = client.request(parsedUrl, reqOptions, (res) => {
        const webStream = Readable.toWeb(res);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          body: webStream
        });
      });

      const timeoutMs = options.timeout || (url.includes("127.0.0.1") || url.includes("localhost") ? 2500 : 1500);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Node connection timeout (${timeoutMs}ms)`));
      });

      req.on("error", (err) => reject(err));

      if (options.signal) {
        if (options.signal.aborted) {
          req.destroy();
          return reject(new Error("Request aborted"));
        }
        options.signal.addEventListener("abort", () => req.destroy(), { once: true });
      }

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
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

  if (url.includes("googleapis.com") || url.includes("openai.com") || url.includes("integrate.api.nvidia.com") || url.includes("anthropic.com") || url.includes("trycloudflare.com")) {
    return false;
  }

  if (format === "ollama" || format === "llama" || url.includes("localhost") || url.includes("127.0.0.1") || url.includes(":11434")) {
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

class AIGateway {
  /**
   * Main entry point for streaming AI responses to SSE or custom handlers
   */
  async generateStream({
    provider = "auto",
    model = "best",
    customUrl = null,
    messages = [],
    conversationSummary = null,
    res = null,
    userPriority = 10,
    jobId = null,
    userId = "system",
    onToken = null
  }) {
    const providerLower = (provider || "auto").toLowerCase();

    if (providerLower === "auto" || providerLower === "ollama") {
      return await this._streamOllamaCluster({
        model,
        customUrl,
        messages,
        conversationSummary,
        res,
        userPriority,
        jobId,
        userId,
        onToken
      });
    }

    if (providerLower === "openai") {
      return await this._streamCloudOpenAI({
        model: model === "best" ? "gpt-4o-mini" : model,
        messages,
        conversationSummary,
        res,
        onToken
      });
    }

    if (providerLower === "gemini") {
      return await this._streamCloudGemini({
        model: model === "best" ? "gemini-2.5-flash" : model,
        messages,
        conversationSummary,
        res,
        onToken
      });
    }

    if (providerLower === "glm" || providerLower === "nvidia") {
      return await this._streamCloudGLM({
        model: model === "best" ? "z-ai/glm-5.2" : model,
        messages,
        conversationSummary,
        res,
        onToken
      });
    }

    throw new Error(`Unsupported AI Provider: ${provider}`);
  }

  /**
   * Streams response from Cluster Server Nodes with Provider Pools, Priority Routing,
   * Least-Loaded Balancing, Intra-Pool & Cross-Pool Failover, and Observability Metrics.
   */
  async _streamOllamaCluster({ model, customUrl, messages, conversationSummary = null, res, userPriority, jobId, userId, onToken, maxTokens = null }) {
    const { getProviderPools, refreshClusterNodesFromDB } = require("./ollamaHelper");
    await refreshClusterNodesFromDB();

    const ServerNode = require("../models/ServerNode");
    const { geminiPool, glmPool, llamaPool, openAiPool, allNodes } = getProviderPools();

    // Group Provider Pools in Priority Fallback Hierarchy: Gemini Pool -> GLM Pool -> LLaMA Pool -> OpenAI Pool
    const poolsHierarchy = [geminiPool, glmPool, llamaPool, openAiPool];

    let selectedNode = null;
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
            ServerNode.findByIdAndUpdate(n.id, { status: "ACTIVE", consecutiveFailures: 0, retryAfter: null }).catch(() => { });
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

      // Intra-Pool Failover Loop: Iterate through sorted candidates in this pool
      for (const currentNode of poolCandidates) {
        triedNodeIds.add(currentNode.id);
        currentNode.activeRequests++;
        currentNode.lastUsedAt = new Date();

        const isCurrentGemini = currentNode.format === "gemini" || currentNode.url.includes("googleapis.com");
        const isCurrentGLM = currentNode.format === "glm" || currentNode.url.includes("integrate.api.nvidia.com");
        let currentModel = (model && model !== "best" && !/^(gpt-4|gpt-3|claude)/i.test(model)) ? model : currentNode.defaultModel;
        if (isCurrentGemini && (!currentModel || currentModel === "best" || currentModel === "gemini-flash-latest" || currentModel === "gemini-1.5-flash" || currentModel === "gemini-2.0-flash" || currentModel === "gemini-2.5-flash" || currentModel === "gemini-3.6-flash")) {
          currentModel = "gemini-2.5-flash";
        }
        if (isCurrentGLM && (!currentModel || currentModel === "best" || currentModel === "llama3.2:3b")) {
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

        const providerName = isCurrentGemini ? "gemini" : isCurrentGLM ? "glm" : (currentNode.format === "openai" || currentNode.url.includes("openai.com")) ? "openai" : "";
        let resolvedApiKey = getProviderApiKey(providerName, currentNode.secretKey);

        const isOfficialCloudService = currentNode.url.includes("api.openai.com") || currentNode.url.includes("googleapis.com") || currentNode.url.includes("integrate.api.nvidia.com");

        if (isOfficialCloudService && (!resolvedApiKey || !resolvedApiKey.trim())) {
          console.warn(`⚠️ [AI GATEWAY DISPATCH SKIPPED] Official cloud node ${currentNode.name} (${currentNode.format}) has no API Key configured. Rotating to next pool...`);
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
          continue;
        }

        const nodeHeaders = { ...headers };
        if (resolvedApiKey) {
          nodeHeaders["Authorization"] = `Bearer ${resolvedApiKey}`;
          nodeHeaders["X-Internal-Secret"] = resolvedApiKey;
        }

        // Build final fetch URL from admin-configured node URL
        // Handle all possible formats admin might store: base URL, /openai suffix, or full path
        let targetFetchUrl;
        if (isCurrentGemini) {
          if (nodeUrl.includes("/chat/completions")) {
            // Already a full endpoint URL
            targetFetchUrl = nodeUrl;
          } else if (nodeUrl.includes("/openai")) {
            // e.g. https://generativelanguage.googleapis.com/v1beta/openai
            targetFetchUrl = `${nodeUrl}/chat/completions`;
          } else if (nodeUrl.includes("googleapis.com")) {
            // e.g. https://generativelanguage.googleapis.com/v1beta
            targetFetchUrl = `${nodeUrl}/openai/chat/completions`;
          } else {
            // Custom Gemini-compatible proxy URL set by admin
            targetFetchUrl = `${nodeUrl}/v1/chat/completions`;
          }
        } else {
          targetFetchUrl = `${nodeUrl}${currentPath}`;
        }

        registerActiveJob(activeJobId, {
          userId,
          userPriority,
          nodeId: currentNode.id,
          res,
          abortController
        });

        // High Availability Model Fallback Tiers for Google Gemini / NVIDIA GLM / Local Ollama
        const modelsToTry = isCurrentGemini
          ? ["gemini-2.5-flash", "gemini-1.5-flash"]
          : isCurrentGLM
          ? [currentModel && currentModel !== "z-ai/glm-5.2" ? currentModel : "z-ai/glm-5.2", "meta/llama-3.3-70b-instruct"]
          : (currentNode.format === "ollama" || isOllamaNode || !isOfficialCloudService)
          ? Array.from(new Set([currentModel, "models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf", process.env.OLLAMA_MODEL || "qwen2.5:1.5b", "llama3.2:3b", "llama3.2", "gemma:2b"])).filter(Boolean)
          : [currentModel];

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

        for (const candidateModel of modelsToTry) {
          const payload = { model: candidateModel, messages: providerMessages, stream: true };
          if (maxTokens) {
            payload.max_tokens = Number(maxTokens);
          }
          if (currentNode.format === "ollama") payload.keep_alive = "24h";

          const dispatchStartTime = performance.now();

          try {
            console.log(`🚀 [AI GATEWAY DISPATCH] RequestId: ${activeJobId} | Provider: ${currentNode.format || "auto"} | Node: ${currentNode.name} (${currentNode.id}) | Priority: ${currentNode.priorityScore} | Model: ${candidateModel}`);

            response = await safeFetch(targetFetchUrl, {
              method: "POST",
              headers: nodeHeaders,
              body: JSON.stringify(payload),
              signal: abortController.signal
            });

            const elapsedMs = (performance.now() - dispatchStartTime).toFixed(2);
            console.log(`⏱️ [AI GATEWAY RESPONSE] RequestId: ${activeJobId} | Node: ${currentNode.name} | Model: ${candidateModel} | HTTP Status: ${response.status} | Latency: ${elapsedMs}ms`);

            if (response.ok) {
              selectedNode = currentNode;
              currentNode.successRequests = (currentNode.successRequests || 0) + 1;
              currentNode.consecutiveFailures = 0;
              currentNode.status = "ACTIVE";
              modelSuccess = true;

              if (currentNode.id && currentNode.id.length === 24) {
                ServerNode.findByIdAndUpdate(currentNode.id, {
                  $inc: { successRequests: 1 },
                  status: "ACTIVE",
                  consecutiveFailures: 0,
                  defaultModel: candidateModel,
                  lastUsedAt: new Date()
                }).catch(() => { });
              }

              break; // Model success! Exit candidate model loop
            } else if (response.status === 429 || response.status === 401) {
              const provType = isCurrentGemini ? "gemini" : isCurrentGLM ? "glm" : "openai";
              rotateProviderApiKey(provType);
              console.warn(`⚠️ [AI GATEWAY NODE RATE_LIMIT] Node '${currentNode.name}' hit HTTP ${response.status}. Rotated API key pool & moving to next cluster node...`);
              errorMessage = `Provider API Rate Limit Exceeded (HTTP ${response.status}) on ${currentNode.name}.`;
              currentNode.status = "RATE_LIMITED";
              currentNode.retryAfter = new Date(Date.now() + 60 * 1000);
              break; // Key rate limited! Break model loop to rotate to NEXT cluster node immediately
            } else if (response.status === 404) {
              console.warn(`⚠️ [AI GATEWAY MODEL 404] Model '${candidateModel}' not found on ${currentNode.name}. Trying next model...`);
              errorMessage = `Model ${candidateModel} not found (HTTP 404).`;
            } else {
              errorMessage = `Server Node ${currentNode.name} returned HTTP ${response.status}.`;
              break; // Non-404 HTTP error, try next node
            }
          } catch (err) {
            errorMessage = `Network connection error on ${currentNode.name}: ${err.message}`;
            console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${currentNode.name} network error: ${err.message}.`);
            break;
          }
        }

        if (modelSuccess && response && response.ok) {
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
          break; // Intra-Pool Success! Exit node loop
        } else {
          currentNode.failedRequests = (currentNode.failedRequests || 0) + 1;
          currentNode.consecutiveFailures = (currentNode.consecutiveFailures || 0) + 1;

          if (response && response.status === 429) {
            currentNode.status = "RATE_LIMITED";
            currentNode.retryAfter = new Date(Date.now() + 60 * 1000);
          } else if (response && (response.status === 401 || response.status === 403)) {
            console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${currentNode.name} returned HTTP ${response.status} (Invalid or Unauthorized API Key). Rotating to next pool...`);
            response = null; // Clear failing response to allow next pool execution
          }

          if (currentNode.id && currentNode.id.length === 24) {
            ServerNode.findByIdAndUpdate(currentNode.id, {
              $inc: { failedRequests: 1, consecutiveFailures: 1 },
              status: currentNode.status,
              retryAfter: currentNode.retryAfter,
              errorMessage
            }).catch(() => { });
          }
          currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
        }
      }
    }

    if (!selectedNode && allNodes.length > 0) {
      selectedNode = allNodes[0];
    }
    if (!selectedNode) {
      selectedNode = { id: "fallback", name: "Fallback Node", activeRequests: 0 };
    }

    try {
      if (response && response.ok && response.body) {
        selectedNode.activeRequests++;
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let rawBuffer = "";
        const streamBuffer = new ActionStreamBuffer(res, onToken);

        while (true) {
          const { done, value } = await reader.read();
          if (value) {
            rawBuffer += decoder.decode(value, { stream: true });
          }

          const events = rawBuffer.split(/\n\n|\r\n\r\n/);
          rawBuffer = events.pop() || "";

          for (const event of events) {
            const lines = event.split(/\r?\n/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let jsonStr = trimmed;
              if (trimmed.startsWith("data:")) {
                jsonStr = trimmed.replace(/^data:\s*/, "").trim();
              }
              if (!jsonStr || jsonStr === "[DONE]") continue;

              try {
                const parsed = JSON.parse(jsonStr);
                const chunkText = parsed.choices?.[0]?.delta?.content ||
                  parsed.choices?.[0]?.message?.content ||
                  parsed.message?.content ||
                  parsed.response || "";
                if (chunkText) {
                  if (!firstTokenTimestamp) {
                    firstTokenTimestamp = performance.now();
                    ttft = firstTokenTimestamp - llmStartTime;
                  }
                  streamBuffer.push(chunkText);
                }
              } catch (e) { }
            }
          }

          if (done) break;
        }

        streamBuffer.flush();
        accumulatedResponseText = streamBuffer.cleanText;
        streamedSuccessfully = true;
      }
    } catch (err) {
      console.warn(`⚠️ [AI GATEWAY ERROR] Stream consumption error: ${err.message}`);
    } finally {
      unregisterActiveJob(activeJobId);
      if (selectedNode) {
        selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);
      }
    }

    if (!accumulatedResponseText || !accumulatedResponseText.trim()) {
      console.warn("⚠️ [AI GATEWAY FALLBACK] Cluster node streaming yielded empty text. Attempting direct Cloud AI Provider fallbacks...");
      try {
        const cloudRes = await this._streamCloudGemini({ model, messages, conversationSummary, res, onToken });
        if (cloudRes && cloudRes.text) {
          accumulatedResponseText = cloudRes.text;
          streamedSuccessfully = true;
        }
      } catch (fErr) {
        console.warn("Direct Gemini fallback notice:", fErr.message);
      }
      if (!accumulatedResponseText || !accumulatedResponseText.trim()) {
        try {
          const cloudRes = await this._streamCloudGLM({ model, messages, conversationSummary, res, onToken });
          if (cloudRes && cloudRes.text) {
            accumulatedResponseText = cloudRes.text;
            streamedSuccessfully = true;
          }
        } catch (fErr) {
          console.warn("Direct GLM fallback notice:", fErr.message);
        }
      }
      if (!accumulatedResponseText || !accumulatedResponseText.trim()) {
        try {
          const cloudRes = await this._streamCloudOpenAI({ model, messages, conversationSummary, res, onToken });
          if (cloudRes && cloudRes.text) {
            accumulatedResponseText = cloudRes.text;
            streamedSuccessfully = true;
          }
        } catch (fErr) {
          console.warn("Direct OpenAI fallback notice:", fErr.message);
        }
      }
    }

    const totalDurationMs = performance.now() - llmStartTime;

    return {
      success: streamedSuccessfully && accumulatedResponseText.trim().length > 0,
      text: accumulatedResponseText,
      errorMessage,
      ttft,
      totalDurationMs,
      nodeId: selectedNode ? selectedNode.id : "unknown"
    };
  }

  /**
   * Cloud OpenAI Stream Fallback Implementation
   */
  async _streamCloudOpenAI({ model, messages, conversationSummary = null, res, onToken }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not configured.");
    }

    const providerMessages = buildProviderAwareContextPayload({
      messages,
      conversationSummary,
      isLocal: false
    });

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

    return { success: true, text: streamBuffer.cleanText };
  }

  /**
   * Cloud Google Gemini Stream Fallback Implementation
   */
  async _streamCloudGemini({ model, messages = [], conversationSummary = null, res, onToken, secretKey = null }) {
    const { clusterState } = require("./ollamaHelper");
    const geminiNode = clusterState.find(n => n.format === "gemini" || n.url.includes("googleapis.com"));

    let geminiNodes = [];
    try {
      const ServerNode = require("../models/ServerNode");
      geminiNodes = await ServerNode.find({
        $or: [{ format: "gemini" }, { url: /googleapis\.com/i }],
        isActive: true,
        secretKey: { $exists: true, $ne: "" }
      });
    } catch (e) {}

    const { decrypt } = require("./encryption");
    const candidateApiKeys = [...new Set([
      secretKey,
      process.env.GEMINI_API_KEY,
      geminiNode?.secretKey,
      ...geminiNodes.map(n => {
        try {
          return n.secretKey ? decrypt(n.secretKey) : "";
        } catch (e) {
          return n.secretKey;
        }
      })
    ].filter(k => k && typeof k === "string" && k.trim().length > 10 && !/[\u2022\*]/.test(k)))];

    if (candidateApiKeys.length === 0) {
      throw new Error("Gemini API Key is missing. Please configure GEMINI_API_KEY or add a Gemini Server Node.");
    }

    const streamBuffer = new ActionStreamBuffer(res, onToken);
    const candidateModels = ["gemini-2.5-flash", "gemini-1.5-flash"];

    const { GoogleGenAI } = require("@google/genai");

    for (const gKey of candidateApiKeys) {
      for (const gModel of candidateModels) {
        try {
          const sysMsg = messages.find(m => m.role === "system")?.content || "";
          const userMsgs = messages.filter(m => m.role !== "system");

          const contentsPayload = userMsgs.map(m => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content || "" }]
          }));

          if (contentsPayload.length === 0) {
            const userMsg = [...messages].reverse().find(m => m.role === "user")?.content || "Hello";
            contentsPayload.push({ role: "user", parts: [{ text: userMsg }] });
          }

          const ai = new GoogleGenAI({ apiKey: gKey });
          const responseStream = await ai.models.generateContentStream({
            model: gModel,
            contents: contentsPayload,
            config: sysMsg ? { systemInstruction: sysMsg } : undefined
          });

          for await (const chunk of responseStream) {
            const chunkText = chunk.text || "";
            if (chunkText) {
              streamBuffer.push(chunkText);
            }
          }
          streamBuffer.flush();

          if (streamBuffer.cleanText && streamBuffer.cleanText.trim()) {
            return { success: true, text: streamBuffer.cleanText };
          }
        } catch (apiErr) {
          const errStatus = apiErr.status || apiErr.response?.status;
          if (errStatus === 429 || apiErr.message?.includes("429")) {
            console.warn(`⚠️ [CLOUD GEMINI KEY RATE LIMIT] Key starting with '${gKey.substring(0, 6)}...' hit 429 Quota Limit. Rotating to next API key...`);
            break;
          } else {
            console.warn(`Gemini cloud model ${gModel} notice:`, apiErr.message || apiErr);
          }
        }
      }
    }

    return { success: false, text: "" };
  }

  /**
   * Cloud NVIDIA GLM Stream Implementation
   */
  async _streamCloudGLM({ model, messages, conversationSummary = null, res, onToken, secretKey = null }) {
    const { clusterState } = require("./ollamaHelper");
    const glmNode = clusterState.find(n => n.format === "glm" || n.url.includes("integrate.api.nvidia.com"));
    const apiKey = secretKey || (glmNode ? glmNode.secretKey : "") || process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      throw new Error("NVIDIA GLM API Key is missing. Please add a secret key to your GLM Server Node in Admin Dashboard.");
    }

    const providerMessages = buildProviderAwareContextPayload({
      messages,
      conversationSummary,
      isLocal: false
    });

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

    return { success: true, text: streamBuffer.cleanText };
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
    this.buffer = "";
    this.cleanText = "";
    this.extractedMeta = [];
    this.firstTokenFired = false;
  }

  push(chunkText) {
    if (!chunkText) return;
    this.buffer += chunkText;

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.substring(0, newlineIndex);
      this.buffer = this.buffer.substring(newlineIndex + 1);
      this._emitLine(line + "\n");
    }
  }

  flush() {
    if (this.buffer.length > 0) {
      this._emitLine(this.buffer);
      this.buffer = "";
    }
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

  _emitLine(lineWithBreak) {
    const sanitizedLine = this._sanitizeVendorBranding(lineWithBreak);
    const trimmed = sanitizedLine.trim();
    const actionMeta = parseActionDirective(trimmed);

    if (actionMeta) {
      this.extractedMeta.push(actionMeta);
      console.log(`📡 [SSE OUT Meta Action]:`, JSON.stringify(actionMeta));
      if (this.res && !this.res.writableEnded) {
        this.res.write(`event: metadata\ndata: ${JSON.stringify(actionMeta)}\n\n`);
      }
    } else {
      this.cleanText += sanitizedLine;
      if (!this.firstTokenFired && typeof this.onToken === "function") {
        this.firstTokenFired = true;
        this.onToken(sanitizedLine);
      }
      if (this.res && !this.res.writableEnded) {
        console.log(`📡 [SSE OUT Chunk]:`, JSON.stringify({ text: sanitizedLine }));
        this.res.write(`event: chunk\ndata: ${JSON.stringify({ type: "chunk", chunk: sanitizedLine, text: sanitizedLine })}\n\n`);
      }
    }
  }
}

module.exports = new AIGateway();
