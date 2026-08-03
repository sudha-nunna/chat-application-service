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
   * Streams response from local Ollama Cluster with Load Balancing & Preemption Support
   */
  async _streamOllamaCluster({ model, customUrl, messages, res, userPriority, jobId, userId, onToken }) {
    let selectedNode = clusterState[0] || { id: "default", name: "Default Node", activeRequests: 0 };
    const triedNodeIds = new Set();
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

    registerActiveJob(activeJobId, {
      userId,
      userPriority,
      nodeId: selectedNode.id,
      res,
      abortController
    });

    // Multi-Node Failover Loop: Tries candidate healthy nodes until HTTP 200 OK is received
    while (triedNodeIds.size < clusterState.length) {
      const candidateNodes = clusterState.filter(n => !triedNodeIds.has(n.id) && !n.status.startsWith("OFFLINE"));
      if (candidateNodes.length === 0) break;

      // Select candidate node with lowest active task count
      candidateNodes.sort((a, b) => a.activeRequests - b.activeRequests);
      const currentNode = candidateNodes[0];
      triedNodeIds.add(currentNode.id);
      currentNode.activeRequests++;

      const isCurrentGemini = currentNode.format === "gemini" || currentNode.url.includes("googleapis.com");
      let currentModel = (model && model !== "best" && !/^(gpt-4|gpt-3|claude)/i.test(model)) ? model : currentNode.defaultModel;
      if (isCurrentGemini) {
        currentModel = "gemini-2.0-flash";
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

      const nodeHeaders = { ...headers };
      if (currentNode.secretKey) {
        nodeHeaders["Authorization"] = `Bearer ${currentNode.secretKey}`;
        nodeHeaders["X-Internal-Secret"] = currentNode.secretKey;
      }

      const payload = { model: currentModel, messages, stream: true };
      if (currentNode.format === "ollama") payload.keep_alive = "24h";

      try {
        console.log(`🚀 [AI GATEWAY DISPATCH] Attempting Node: ${currentNode.name} (${currentNode.id}) | Path: ${currentPath} | Model: ${currentModel}`);
        response = await fetch(`${nodeUrl}${currentPath}`, {
          method: "POST",
          headers: nodeHeaders,
          body: JSON.stringify(payload),
          signal: abortController.signal
        });

        if (response.ok) {
          selectedNode = currentNode;
          break; // Success! Exit failover loop and stream response
        } else {
          console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${currentNode.name} (${currentNode.id}) returned HTTP ${response.status}. Trying next available server node...`);
          if (response.status === 429) {
            errorMessage = "Google Gemini / Provider API rate limit or daily quota exceeded (HTTP 429).";
          } else {
            errorMessage = `AI Server Node ${currentNode.name} returned HTTP ${response.status}.`;
          }
        }
      } catch (err) {
        console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${currentNode.name} network error: ${err.message}. Trying next available server node...`);
        errorMessage = `Network error connecting to node ${currentNode.name}: ${err.message}`;
      } finally {
        currentNode.activeRequests = Math.max(0, currentNode.activeRequests - 1);
      }
    }

    if (selectedNode) {
      selectedNode.activeRequests++;
    }

    try {
      if (response && response.ok && response.body) {
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
                    res.write(`data: ${JSON.stringify({ type: "chunk", chunk: chunkText, text: chunkText })}\n\n`);
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
      console.warn(`⚠️ [AI GATEWAY ERROR] Ollama execution error: ${err.message}`);
    } finally {
      unregisterActiveJob(activeJobId);
      selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);
    }

    const totalDurationMs = performance.now() - llmStartTime;

    return {
      success: streamedSuccessfully && accumulatedResponseText.trim().length > 0,
      text: accumulatedResponseText,
      errorMessage,
      ttft,
      totalDurationMs,
      nodeId: selectedNode.id
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
