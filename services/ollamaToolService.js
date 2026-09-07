/**
 * ollamaToolService.js
 * Multi-turn Agentic Tool-Calling Service for Ollama & Cloud Models.
 * Executes native tool loops for web search & page fetching when an API key is available,
 * with automatic fallback to DuckDuckGo if cloud endpoints fail.
 */

const { Ollama } = require("ollama");
const webSearchService = require("./webSearchService");

// Define Web Search Tool Schema (OpenAI/Ollama compliant)
const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for real-time news, live market prices, documentation, and current events.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The specific search query string to look up."
        },
        max_results: {
          type: "number",
          description: "Number of search results to retrieve (1-10)."
        }
      },
      required: ["query"]
    }
  }
};

// Define Web Fetch Tool Schema
const webFetchTool = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch and read the raw text content of a specific webpage URL.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full http/https URL to retrieve."
        }
      },
      required: ["url"]
    }
  }
};

/**
 * Estimates token count for a string or message array (~3.8 chars per token).
 */
function estimateTokens(input) {
  if (!input) return 0;
  if (Array.isArray(input)) {
    let count = 0;
    for (const msg of input) {
      const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      count += estimateTokens(contentStr) + 4;
    }
    return Math.max(1, count);
  }
  const str = String(input).trim();
  if (!str) return 0;
  return Math.max(1, Math.round(str.length / 3.8));
}

/**
 * Executes a web search using Ollama Cloud if available, otherwise DuckDuckGo.
 */
async function executeWebSearch(args, ollamaClient) {
  const query = args?.query || (typeof args === "string" ? args : "");
  if (!query) return { error: "No search query provided." };

  // 1. Try Ollama Cloud webSearch if supported
  if (ollamaClient && typeof ollamaClient.webSearch === "function") {
    try {
      const cloudRes = await ollamaClient.webSearch({
        query,
        max_results: args.max_results || 5
      });
      if (cloudRes && cloudRes.results && cloudRes.results.length > 0) {
        return {
          results: cloudRes.results,
          provider: "ollama_cloud"
        };
      }
    } catch (cloudErr) {
      console.warn(`⚠️ [OLLAMA TOOL] Cloud webSearch failed (${cloudErr.message}), falling back to DuckDuckGo.`);
    }
  }

  // 2. Fallback to free DuckDuckGo search
  const ddgRes = await webSearchService.searchDuckDuckGo(query);
  if (ddgRes && ddgRes.sources && ddgRes.sources.length > 0) {
    return {
      results: ddgRes.sources,
      provider: "duckduckgo"
    };
  }

  return { results: [], message: "No search results found for query." };
}

/**
 * Executes a webpage fetch using Ollama Cloud if available, otherwise native fetch.
 */
async function executeWebFetch(args, ollamaClient) {
  const url = args?.url || (typeof args === "string" ? args : "");
  if (!url) return { error: "No URL provided to fetch." };

  if (ollamaClient && typeof ollamaClient.webFetch === "function") {
    try {
      const cloudRes = await ollamaClient.webFetch({ url });
      if (cloudRes && cloudRes.content) {
        return { content: cloudRes.content.slice(0, 8000), provider: "ollama_cloud" };
      }
    } catch (cloudErr) {
      console.warn(`⚠️ [OLLAMA TOOL] Cloud webFetch failed (${cloudErr.message}), falling back to native fetch.`);
    }
  }

  const pageContent = await webSearchService.fetchUrlContent(url);
  if (pageContent && pageContent.formattedContext) {
    return { content: pageContent.formattedContext.slice(0, 8000), provider: "native_fetch" };
  }

  return { error: "Failed to fetch webpage content." };
}

/**
 * Executes multi-turn agentic chat with tools and streams the final answer.
 * 
 * @param {Object} params
 * @param {string} params.model - Model identifier (e.g. "deepseek-v4-flash:cloud")
 * @param {Array} params.messages - Initial messages array [{ role, content }]
 * @param {Object} params.node - Resolved ServerNode from DB (url, secretKey)
 * @param {Object} params.res - Express HTTP SSE response stream
 * @param {Function} params.onToken - Callback on each emitted token
 * @returns {Promise<Object>} { success, text, promptTokens, completionTokens, sources }
 */
async function streamAgenticChat({
  model,
  messages = [],
  node = null,
  res = null,
  onToken = null
}) {
  const host = (node && node.url) ? node.url.replace(/\/$/, "") : "https://ollama.com";
  const apiKey = (node && node.secretKey) ? node.secretKey : "";

  const ollama = new Ollama({
    host,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
  });

  const toolImplementations = {
    web_search: (args) => executeWebSearch(args, ollama),
    web_fetch: (args) => executeWebFetch(args, ollama)
  };

  let currentMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : (m.content?.text || JSON.stringify(m.content))
  }));

  const collectedSources = [];
  let loopCount = 0;
  const MAX_TOOL_TURNS = 5;

  console.log(`🤖 [AGENTIC TOOL LOOP START] Model: ${model} | Host: ${host} | Auth: ${apiKey ? "Key Present" : "No Key"}`);

  while (loopCount < MAX_TOOL_TURNS) {
    loopCount++;

    let response;
    try {
      response = await ollama.chat({
        model,
        messages: currentMessages,
        tools: [webSearchTool, webFetchTool],
        think: true
      });
    } catch (chatErr) {
      console.error(`❌ [OLLAMA TOOL CHAT ERROR]: ${chatErr.message}`);
      throw chatErr;
    }

    const assistantMsg = response.message;
    currentMessages.push(assistantMsg);

    // If no tool_calls, model gave final answer!
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const finalContent = assistantMsg.content || "";

      // Stream the final response to frontend via SSE in standard chunks
      if (res && typeof res.write === "function") {
        const tokens = finalContent.match(/\s+|\S+/g) || [finalContent];
        for (const token of tokens) {
          res.write(`data: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
          if (onToken) onToken(token);
          if (typeof res.flush === "function") {
            try { res.flush(); } catch (e) {}
          }
          await new Promise((resolve) => setTimeout(resolve, 12));
        }
      }

      return {
        success: true,
        text: finalContent,
        promptTokens: estimateTokens(currentMessages),
        completionTokens: estimateTokens(finalContent),
        sources: collectedSources
      };
    }

    // Model requested one or more tool calls
    for (const call of assistantMsg.tool_calls) {
      const fnName = call.function?.name;
      const fn = toolImplementations[fnName];

      let args = call.function?.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch (e) {}
      }

      console.log(`  🔧 [TOOL CALL] Executing: ${fnName} with query/url: "${args?.query || args?.url || JSON.stringify(args)}"`);

      let toolResult;
      if (!fn) {
        toolResult = { error: `Unknown tool: ${fnName}` };
      } else {
        try {
          toolResult = await fn(args);
          if (toolResult?.results && Array.isArray(toolResult.results)) {
            collectedSources.push(...toolResult.results);
          }
        } catch (err) {
          toolResult = { error: `${fnName} failed: ${err.message}` };
        }
      }

      // Notify frontend of completed search/fetch with sources
      if (res && typeof res.write === "function") {
        res.write(`data: ${JSON.stringify({
          type: "search_status",
          sources: Array.isArray(toolResult?.results) ? toolResult.results : collectedSources,
          query: args?.query || args?.url || "Searching...",
          tool: fnName
        })}\n\n`);
        if (typeof res.flush === "function") {
          try { res.flush(); } catch (e) {}
        }
      }

      currentMessages.push({
        role: "tool",
        content: JSON.stringify(toolResult).slice(0, 8000),
        tool_name: fnName
      });
    }
  }

  // Fallback if loop limit exceeded
  const lastMsg = currentMessages[currentMessages.length - 1];
  const fallbackText = lastMsg?.content || "Completed tool search.";
  if (res && typeof res.write === "function") {
    const tokens = fallbackText.match(/\s+|\S+/g) || [fallbackText];
    for (const token of tokens) {
      res.write(`data: ${JSON.stringify({ type: "chunk", chunk: token, text: token })}\n\n`);
      if (onToken) onToken(token);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  }
  return {
    success: true,
    text: fallbackText,
    promptTokens: estimateTokens(currentMessages),
    completionTokens: estimateTokens(fallbackText),
    sources: collectedSources
  };
}

module.exports = {
  streamAgenticChat,
  webSearchTool,
  webFetchTool,
  executeWebSearch,
  executeWebFetch
};
