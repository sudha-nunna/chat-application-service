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
    const selectedNode = selectBestClusterNode(userPriority);
    selectedNode.activeRequests++;

    const abortController = new AbortController();
    const activeJobId = jobId || `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    registerActiveJob(activeJobId, {
      userId,
      userPriority,
      nodeId: selectedNode.id,
      res,
      abortController
    });

    let targetModel = (model && model !== "best" && !/^(gpt-4|gpt-3|claude)/i.test(model))
      ? model
      : selectedNode.defaultModel;

    const isGeminiNode = selectedNode.format === "gemini" || selectedNode.url.includes("googleapis.com");
    if (isGeminiNode) {
      if (!targetModel || targetModel === "llama3.2:3b" || targetModel === "gemini-1.5-flash" || targetModel === "gemini-1.5") {
        targetModel = "gemini-2.5-flash";
      }
    }

    const targetUrl = customUrl ? customUrl.trim().replace(/\/$/, "") : selectedNode.url;

    let accumulatedResponseText = "";
    let streamedSuccessfully = false;
    let ttft = 0;
    let firstTokenTimestamp = null;
    const llmStartTime = performance.now();

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/event-stream"
    };

    const rawSecretKey = selectedNode.secretKey || "";
    if (rawSecretKey) {
      headers["Authorization"] = `Bearer ${rawSecretKey}`;
      headers["X-Internal-Secret"] = rawSecretKey;
    }

    try {
      const isCloudOrOpenAIFormat = selectedNode.format === "openai" || selectedNode.format === "gemini" || selectedNode.url.includes("googleapis.com") || selectedNode.url.includes("openai.com") || selectedNode.url.includes("trycloudflare.com");
      const endpointPath = isCloudOrOpenAIFormat ? "/v1/chat/completions" : "/api/chat";

      const requestPayload = {
        model: targetModel,
        messages,
        stream: true
      };

      if (selectedNode.format === "ollama") {
        requestPayload.keep_alive = "24h";
      }

      let response = await fetch(`${targetUrl}${endpointPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: abortController.signal
      });

      // Failover to secondary cluster node if primary node fails
      if (!response.ok) {
        console.warn(`⚠️ [AI GATEWAY FAILOVER] Node ${selectedNode.id} HTTP ${response.status}. Decrementing activeRequests and attempting fallback node...`);
        selectedNode.activeRequests = Math.max(0, selectedNode.activeRequests - 1);

        const fallbackNode = selectBestClusterNodeWithPreemption(userPriority, clusterState, true);

        if (fallbackNode && fallbackNode.id !== selectedNode.id) {
          fallbackNode.activeRequests++;
          const isFallbackCloud = fallbackNode.format === "openai" || fallbackNode.format === "gemini" || fallbackNode.url.includes("googleapis.com") || fallbackNode.url.includes("trycloudflare.com");
          const fallbackPath = isFallbackCloud ? "/v1/chat/completions" : "/api/chat";
          const fallbackHeaders = { ...headers };
          if (fallbackNode.secretKey) {
            fallbackHeaders["Authorization"] = `Bearer ${fallbackNode.secretKey}`;
            fallbackHeaders["X-Internal-Secret"] = fallbackNode.secretKey;
          }

          response = await fetch(`${fallbackNode.url}${fallbackPath}`, {
            method: "POST",
            headers: fallbackHeaders,
            body: JSON.stringify({
              model: fallbackNode.defaultModel,
              messages,
              stream: true
            }),
            signal: abortController.signal
          });
        }
      }

      if (response.ok && response.body) {
        const reader = response.body.getReader();
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
