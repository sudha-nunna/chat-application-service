/**
 * webSearchService.js
 * High-performance Web Search (via DuckDuckGo) & URL Fetching Service.
 * Injects real-time search context into AI prompts when enableSearch is true.
 * Requires NO external API keys. Fails gracefully to empty string on any error.
 */

const SEARCH_TIMEOUT_MS = parseInt(process.env.SEARCH_TIMEOUT_MS || "8000", 10);
const MAX_SEARCH_RESULTS = parseInt(process.env.MAX_SEARCH_RESULTS || "5", 10);

/**
 * Validates whether an IP or hostname belongs to private/internal networks (SSRF defense).
 */
function isPrivateOrLocalHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();

  if (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".localhost") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower === "127.0.0.1"
  ) {
    return true;
  }

  // IPv4 Private Ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const oct1 = parseInt(ipv4Match[1], 10);
    const oct2 = parseInt(ipv4Match[2], 10);
    if (oct1 === 10) return true;
    if (oct1 === 127) return true;
    if (oct1 === 169 && oct2 === 254) return true;
    if (oct1 === 172 && oct2 >= 16 && oct2 <= 31) return true;
    if (oct1 === 192 && oct2 === 168) return true;
    if (oct1 === 0) return true;
  }

  return false;
}

/**
 * Strips HTML tags and unescapes common HTML entities.
 */
function cleanHtmlText(text) {
  if (!text) return "";
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Searches DuckDuckGo HTML endpoint and parses organic search results.
 */
async function searchDuckDuckGo(query) {
  if (!query || !query.trim()) return "";

  const params = new URLSearchParams({ q: query.trim() });
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    },
    body: params.toString(),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned HTTP status ${response.status}`);
  }

  const html = await response.text();
  const results = [];
  const blocks = html.split(/class="result\s/);

  for (let i = 1; i < blocks.length && results.length < MAX_SEARCH_RESULTS; i++) {
    const block = blocks[i];

    // Exclude sponsored / ad blocks
    if (block.includes("result--ad") || block.includes("badge--ad") || block.includes("duckduckgo.com/y.js")) {
      continue;
    }

    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (titleMatch) {
      let rawUrl = titleMatch[1];
      if (rawUrl.includes("y.js")) continue;

      // Extract target URL from DuckDuckGo redirect wrapper if present
      if (rawUrl.includes("uddg=")) {
        const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          try {
            rawUrl = decodeURIComponent(uddgMatch[1]);
          } catch {
            // Keep rawUrl if decoding fails
          }
        }
      }

      const title = cleanHtmlText(titleMatch[2]);
      const snippet = snippetMatch ? cleanHtmlText(snippetMatch[1]) : "";

      if (title && rawUrl.startsWith("http")) {
        results.push({ title, url: rawUrl, snippet });
      }
    }
  }

  if (results.length === 0) {
    return "";
  }

  let formattedContext = "[WEB SEARCH RESULTS]\n";
  results.forEach((item, index) => {
    formattedContext += `\n[Source ${index + 1}]\nTitle: ${item.title}\nURL: ${item.url}\nSnippet: ${item.snippet}\n`;
  });
  formattedContext += "\n[INSTRUCTIONS FOR AI ASSISTANT]\n";
  formattedContext += "Use the above search results to provide a factual, accurate, and up-to-date answer. Cite URLs where appropriate.";

  return formattedContext;
}

/**
 * Fetches and cleans textual content from an explicit URL.
 */
async function fetchUrlContent(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (isPrivateOrLocalHost(parsed.hostname)) {
      console.warn(`⚠️ [WEB FETCH] Blocked private/internal URL: ${targetUrl}`);
      return "";
    }

    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text") && !contentType.includes("html") && !contentType.includes("json")) {
      return "";
    }

    const rawBody = await response.text();
    const cleanText = cleanHtmlText(rawBody).slice(0, 4000);

    if (!cleanText) return "";

    return `[WEB PAGE CONTENT: ${targetUrl}]\n${cleanText}\n[END OF WEB PAGE CONTENT]\n\nUse the webpage content above to answer the user's question accurately.`;
  } catch (err) {
    console.warn(`⚠️ [WEB FETCH] Failed to fetch URL (${targetUrl}):`, err.message);
    return "";
  }
}

/**
 * Main entry point: checks if prompt contains a URL or needs a web search.
 * Returns formatted context string, or "" on failure/empty.
 */
async function searchOrFetch(userPrompt) {
  if (!userPrompt || typeof userPrompt !== "string") return "";

  const trimmed = userPrompt.trim();
  const urlMatch = trimmed.match(/(https?:\/\/[^\s]+)/);

  try {
    if (urlMatch) {
      const url = urlMatch[0];
      const pageContent = await fetchUrlContent(url);
      if (pageContent) return pageContent;
    }

    return await searchDuckDuckGo(trimmed);
  } catch (err) {
    console.warn("⚠️ [WEB SEARCH] Graceful skip on error:", err.message);
    return "";
  }
}

module.exports = {
  searchOrFetch,
  searchDuckDuckGo,
  fetchUrlContent
};
