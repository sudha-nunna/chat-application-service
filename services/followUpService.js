/**
 * followUpService.js
 * Generates 3 context-aware, engaging follow-up suggestion questions
 * after every AI response (similar to ChatGPT and OpenWebUI).
 *
 * Uses intelligent contextual heuristics (<1ms latency) with an optional ultra-fast
 * sub-second LLM race (max 800ms timeout) so the user never experiences delays.
 */

const { selectBestClusterNode, clusterState } = require("../utils/ollamaHelper");

// Strict 800ms cap to guarantee instant response completion without lag
const FOLLOW_UP_TIMEOUT_MS = 800;

/**
 * High-performance smart contextual follow-up question generator.
 * Operates in <1ms without network overhead.
 */
function getSmartFollowUps(userPrompt, assistantResponse) {
  const prompt = (userPrompt || "").trim();
  const response = (assistantResponse || "").trim();
  const combined = `${prompt} ${response}`.toLowerCase();

  // Extract core topic/subject phrase from user's prompt if available
  let topic = "";
  const topicMatch = prompt.match(/(?:about|for|in|on|with|explain|what is|what are|difference between|how to|why is|how does)\s+([a-zA-Z0-9_\-\s]{2,30})/i);
  if (topicMatch && topicMatch[1]) {
    topic = topicMatch[1].trim().replace(/[?!.,]+$/, "");
  }

  // 1. Math / Calculations / Numbers
  if (/(\d+\s*[\+\-\*\/=]\s*\d+|\bcalculate\b|\bformula\b|\bequation\b|\bsolve\b|\bmath\b|\balgebra\b|\bgeometry\b)/i.test(combined)) {
    return [
      "Can you show the step-by-step calculations?",
      "Can you give another practice problem like this?",
      "What formula or mathematical rule was applied here?"
    ];
  }

  // 2. Coding / Technical / Software Development
  if (/(\bcode\b|\bfunction\b|\bcomponent\b|\berror\b|\bbug\b|\bapi\b|\bdatabase\b|\bquery\b|\bcss\b|\bhtml\b|\breact\b|\bnode\b|\bpython\b|\bjavascript\b|\btypescript\b|\bgit\b|\bdocker\b|\bsql\b)/i.test(combined)) {
    return [
      topic ? `Can you show a complete code example for ${topic}?` : "Can you show a complete code example?",
      topic ? `How do I handle errors and edge cases in ${topic}?` : "How do I handle errors and edge cases for this?",
      topic ? `What are best practices and optimizations for ${topic}?` : "What are the best practices and optimizations?"
    ];
  }

  // 3. Comparisons & Pros / Cons
  if (/(\bcompare\b|\bdifference\b|\bvs\b|\bversus\b|\balternative\b|\bpros and cons\b|\btradeoff\b)/i.test(combined)) {
    return [
      topic ? `What are the main trade-offs with ${topic}?` : "What are the main pros and cons?",
      "Which option is better for production use?",
      "Can you give a practical real-world scenario?"
    ];
  }

  // 4. Conceptual / Architectural / Deep Explanations
  if (/(\bwhy\b|\bhow does\b|\bexplain\b|\bconcept\b|\btheory\b|\barchitecture\b|\bunder the hood\b)/i.test(combined)) {
    return [
      topic ? `Can you give a real-world analogy for ${topic}?` : "Can you give a real-world analogy for this?",
      topic ? `What are common misconceptions about ${topic}?` : "What are common misconceptions about this?",
      "What should I explore or study next?"
    ];
  }

  // 5. Guides / How-to / Deployments / Tutorials
  if (/(\bhow to\b|\bguide\b|\btutorial\b|\bstep\b|\bdeploy\b|\binstall\b|\bsetup\b|\bconfig\b)/i.test(combined)) {
    return [
      "What are common pitfalls or mistakes to avoid?",
      "What tools or prerequisites are recommended?",
      "How can I test or verify that this is working?"
    ];
  }

  // 6. History / Events / News / People
  if (/(\bhistory\b|\bwho is\b|\bwho was\b|\bwhen did\b|\bevent\b|\bnews\b|\bcountry\b|\bwar\b|\bcentury\b)/i.test(combined)) {
    return [
      "What were the most significant consequences of this?",
      "What impact does this have today?",
      "Can you provide a timeline of key milestones?"
    ];
  }

  // 7. Conversational with extracted topic
  if (topic && topic.length > 2 && topic.length < 35) {
    return [
      `Can you share practical examples of ${topic}?`,
      `What are the most important things to know about ${topic}?`,
      `What would you recommend doing next with ${topic}?`
    ];
  }

  // Default clean conversational follow-ups
  return [
    "Can you provide more specific details on this?",
    "What are practical examples of this in action?",
    "What would you recommend doing next?"
  ];
}

/**
 * Backward compatibility alias for getSmartFollowUps.
 */
function getHeuristicFollowUps(userPrompt, assistantResponse) {
  return getSmartFollowUps(userPrompt, assistantResponse);
}

/**
 * Helper to sanitize and normalize a question string.
 */
function cleanQuestionString(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/^[\s\*\-\d\.\)\>\"\'\`]+/, "")
    .replace(/[\"\'\`]+$/, "")
    .trim();
}

/**
 * Robust extraction of 3 questions from raw LLM output.
 */
function extractQuestions(rawText) {
  if (!rawText || typeof rawText !== "string") return [];

  // 1. Try JSON array match first
  try {
    const cleanedJson = rawText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
    const match = cleanedJson.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const questions = parsed
          .map(cleanQuestionString)
          .filter(q => q.length > 3 && q.length < 130);
        if (questions.length >= 2) {
          return questions.slice(0, 3);
        }
      }
    }
  } catch (_) {}

  // 2. Resilient fallback: parse line-by-line
  const lines = rawText
    .split(/\r?\n/)
    .map(cleanQuestionString)
    .filter(line => line.length > 5 && line.length < 130 && (line.endsWith("?") || /^(what|how|can|why|is|are|could|should|where|when|which|do|does)/i.test(line)));

  if (lines.length >= 2) {
    return lines.slice(0, 3);
  }

  return [];
}

/**
 * Generates 3 context-aware follow-up questions for the given user prompt and assistant reply.
 * Never blocks the client stream: executes with strict 800ms deadline.
 *
 * @param {string} userPrompt
 * @param {string} assistantResponse
 * @param {object} [options={}]
 * @returns {Promise<string[]>} Exactly 3 follow-up question strings
 */
async function generateFollowUps(userPrompt, assistantResponse, options = {}) {
  if (!userPrompt || !assistantResponse || !assistantResponse.trim()) {
    return [];
  }

  const cleanUser = userPrompt.trim().slice(0, 400);
  const cleanAssistant = assistantResponse.trim().slice(0, 1000);

  // 1. Resolve active serving cluster node
  let node = options.preResolvedNodeHint;
  if (!node && options.nodeId && Array.isArray(clusterState)) {
    node = clusterState.find(n => n.id === options.nodeId || n._id?.toString() === options.nodeId);
  }

  if (!node && (!clusterState || clusterState.length === 0)) {
    try {
      const { refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
      await refreshClusterNodesFromDB();
    } catch (_) {}
  }

  if (!node || !node.url) {
    node = selectBestClusterNode(50);
  }

  if (!node || !node.url) {
    return getSmartFollowUps(cleanUser, cleanAssistant);
  }

  const cleanUrl = (node.url || "").replace(/\/+$/, "");

  // Fast-fail non-API / dummy URLs immediately to prevent 5s timeout hangs
  if (cleanUrl.includes("ollama.com") || (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://"))) {
    return getSmartFollowUps(cleanUser, cleanAssistant);
  }

  const prompt = `Based on this conversation, generate exactly 3 concise, relevant follow-up questions the user might ask next.

User: "${cleanUser}"
Assistant: "${cleanAssistant}"

RULES:
- Return ONLY a JSON array of 3 short question strings.
- No markdown, no numbering, no explanations.
- Each question under 70 characters.

Example: ["Can you show an example?", "What are the common mistakes?", "How do I test this?"]`;

  try {
    const isCodegene = cleanUrl.includes("ai.codegene.io") || (node.name && node.name.toLowerCase().includes("codegene"));
    const isStandardOpenAi = node.format === "openai" || cleanUrl.includes("openai.com") || cleanUrl.includes("integrate.api.nvidia.com");
    const isGemini = node.format === "gemini" || cleanUrl.includes("googleapis.com");

    let endpoint;
    if (isCodegene) {
      endpoint = cleanUrl.endsWith("/v1/chat/completions")
        ? cleanUrl
        : cleanUrl.endsWith("/v1")
        ? `${cleanUrl}/chat/completions`
        : `${cleanUrl}/v1/chat/completions`;
    } else if (cleanUrl.includes("googleapis.com")) {
      endpoint = `${cleanUrl}/openai/chat/completions`;
    } else if (isStandardOpenAi || isGemini || node.format === "glm") {
      endpoint = cleanUrl.endsWith("/chat/completions")
        ? cleanUrl
        : cleanUrl.endsWith("/v1")
        ? `${cleanUrl}/chat/completions`
        : `${cleanUrl}/v1/chat/completions`;
    } else {
      endpoint = cleanUrl.endsWith("/api/chat") ? cleanUrl : `${cleanUrl}/api/chat`;
    }

    const resolvedApiKey = (node.secretKey && !/[\u2022\*]/.test(node.secretKey)) ? node.secretKey : "";
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (AI-Assistant)"
    };
    if (resolvedApiKey) {
      headers["Authorization"] = `Bearer ${resolvedApiKey}`;
      headers["X-Internal-Secret"] = resolvedApiKey;
    }

    const targetModel = options.model && options.model !== "auto" && options.model !== "best"
      ? options.model
      : (node.defaultModel || (Array.isArray(node.supportedModels) && node.supportedModels[0]) || "gemini-3.5-flash-lite");

    const messages = [
      { role: "system", content: "You generate exactly 3 concise follow-up questions as a JSON array of strings." },
      { role: "user", content: prompt }
    ];

    let requestBody;
    if (endpoint.includes("/api/chat")) {
      requestBody = {
        model: targetModel,
        messages,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 200
        }
      };
    } else {
      requestBody = {
        model: targetModel,
        messages,
        temperature: 0.7,
        max_tokens: 200,
        stream: false
      };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS)
    });

    if (!res.ok) {
      throw new Error(`Node returned HTTP ${res.status}`);
    }

    const data = await res.json();
    let rawText = "";

    const choiceMessage = data.choices && data.choices[0]?.message;
    if (choiceMessage) {
      rawText = (choiceMessage.content && choiceMessage.content.trim())
        ? choiceMessage.content
        : (choiceMessage.reasoning || "");
    } else if (data.message?.content) {
      rawText = data.message.content;
    } else if (data.response) {
      rawText = data.response;
    }

    if (rawText) {
      const extracted = extractQuestions(rawText);
      if (extracted.length >= 2) {
        if (extracted.length === 2) {
          const fallbacks = getSmartFollowUps(cleanUser, cleanAssistant);
          const additional = fallbacks.find(f => !extracted.includes(f)) || "What would you recommend doing next?";
          extracted.push(additional);
        }
        return extracted.slice(0, 3);
      }
    }
  } catch (err) {
    // Graceful silent fallback to smart contextual questions on timeout or error
  }

  return getSmartFollowUps(cleanUser, cleanAssistant);
}

module.exports = {
  generateFollowUps,
  getSmartFollowUps,
  getHeuristicFollowUps,
  extractQuestions
};
