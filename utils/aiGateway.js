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
const { selectBestClusterNode, clusterState } = require("./ollamaHelper");
const { selectBestClusterNodeWithPreemption, registerActiveJob, unregisterActiveJob } = require("./priorityDispatcher");

class AIGateway {
  /**
   * Main entry point for streaming AI responses to SSE or custom handlers
   */
  async generateStream({
    provider = "auto",
    model = "best",
    customUrl = null,
    messages = [],
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
        res,
        onToken
      });
    }

    if (providerLower === "gemini") {
      return await this._streamCloudGemini({
        model: model === "best" ? "gemini-1.5-flash" : model,
        messages,
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
  async _streamOllamaCluster({ model, customUrl, messages, res, userPriority, jobId, userId, onToken }) {
    const { getProviderPools, refreshClusterNodesFromDB } = require("./ollamaHelper");
    await refreshClusterNodesFromDB();

    const ServerNode = require("../models/ServerNode");
    const { geminiPool, llamaPool, openAiPool, allNodes } = getProviderPools();

    // Group Provider Pools in Priority Fallback Hierarchy: Gemini Pool -> LLaMA Pool -> OpenAI Pool
    const poolsHierarchy = [geminiPool, llamaPool, openAiPool];

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

      // Filter available non-rate-limited and active candidates in current pool
      let poolCandidates = currentPool.filter(n =>
        !triedNodeIds.has(n.id) &&
        n.status !== "INACTIVE" &&
        !(n.status === "RATE_LIMITED" && n.retryAfter && new Date(n.retryAfter) > now)
      );

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
        let currentModel = (model && model !== "best" && !/^(gpt-4|gpt-3|claude)/i.test(model)) ? model : currentNode.defaultModel;
        if (isCurrentGemini && (!currentModel || currentModel === "gemini-2.0-flash" || currentModel === "best")) {
          currentModel = "gemini-2.5-flash";
        }

        const nodeUrl = customUrl ? customUrl.trim().replace(/\/$/, "") : currentNode.url;
        const isCloudOrOpenAI = currentNode.format === "openai" || currentNode.format === "gemini" || currentNode.url.includes("googleapis.com") || currentNode.url.includes("openai.com") || currentNode.url.includes("trycloudflare.com");

        let currentPath;
        if (isCurrentGemini) {
          currentPath = nodeUrl.endsWith("/openai") ? "/chat/completions" : "/v1/chat/completions";
        } else if (isCloudOrOpenAI) {
          currentPath = "/v1/chat/completions";
        } else {
          currentPath = "/api/chat";
        }

        let resolvedApiKey = currentNode.secretKey;
        if (!resolvedApiKey || typeof resolvedApiKey !== "string" || !resolvedApiKey.trim()) {
          if (isCurrentGemini) {
            resolvedApiKey = process.env.GEMINI_API_KEY || "";
          } else if (currentNode.format === "openai" || currentNode.url.includes("openai.com")) {
            resolvedApiKey = process.env.OPENAI_API_KEY || "";
          }
        }

        const nodeHeaders = { ...headers };
        if (resolvedApiKey) {
          nodeHeaders["Authorization"] = `Bearer ${resolvedApiKey}`;
          nodeHeaders["X-Internal-Secret"] = resolvedApiKey;
        }

        const targetFetchUrl = `${nodeUrl}${currentPath}`;

        registerActiveJob(activeJobId, {
          userId,
          userPriority,
          nodeId: currentNode.id,
          res,
          abortController
        });

        // High Availability Model Fallback Tiers for Google Gemini (prioritizing 100% active models)
        const modelsToTry = isCurrentGemini
          ? ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]
          : [currentModel];

        let modelSuccess = false;

        for (const candidateModel of modelsToTry) {
          const payload = { model: candidateModel, messages, stream: true };
          if (currentNode.format === "ollama") payload.keep_alive = "24h";

          const dispatchStartTime = performance.now();

          try {
            console.log(`🚀 [AI GATEWAY DISPATCH] RequestId: ${activeJobId} | Provider: ${currentNode.format || "auto"} | Node: ${currentNode.name} (${currentNode.id}) | Priority: ${currentNode.priorityScore} | Model: ${candidateModel}`);

            response = await fetch(targetFetchUrl, {
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
            } else if (response.status === 429 || response.status === 404) {
              console.warn(`⚠️ [AI GATEWAY MODEL ROTATION] Model '${candidateModel}' returned HTTP ${response.status}. Rotating to next model tier...`);
              errorMessage = `Provider API Rate Limit Exceeded (HTTP ${response.status}) on ${currentNode.name} (${candidateModel}).`;
            } else {
              errorMessage = `Server Node ${currentNode.name} returned HTTP ${response.status}.`;
              break; // Non-404/429 HTTP error, try next node
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
                  accumulatedResponseText += chunkText;

                  if (typeof onToken === "function") {
                    onToken(chunkText);
                  }

                  if (res && !res.writableEnded) {
                    res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunkText })}\n\n`);
                  }
                }
              } catch (e) { }
            }
          }

          if (done) break;
        }
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
  async _streamCloudOpenAI({ model, messages, res, onToken }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not configured.");
    }

    const { OpenAI } = require("openai");
    const openai = new OpenAI({ apiKey });
    const stream = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages,
      stream: true
    });

    let accumulatedText = "";
    for await (const chunk of stream) {
      const chunkText = chunk.choices[0]?.delta?.content || "";
      if (chunkText) {
        accumulatedText += chunkText;
        if (typeof onToken === "function") onToken(chunkText);
        if (res && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "chunk", chunk: chunkText, text: chunkText })}\n\n`);
        }
      }
    }

    return { success: true, text: accumulatedText };
  }

  /**
   * Cloud Google Gemini Stream Fallback Implementation
   */
  async _streamCloudGemini({ model, messages, res, onToken }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not configured.");
    }

    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const responseStream = await ai.models.generateContentStream({
      model: model || "gemini-1.5-flash",
      contents: messages.map(m => `${m.role}: ${m.content}`).join("\n")
    });

    let accumulatedText = "";
    for await (const chunk of responseStream) {
      const chunkText = chunk.text || "";
      if (chunkText) {
        accumulatedText += chunkText;
        if (typeof onToken === "function") onToken(chunkText);
        if (res && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "chunk", chunk: chunkText, text: chunkText })}\n\n`);
        }
      }
    }

    return { success: true, text: accumulatedText };
  }
}

module.exports = new AIGateway();
