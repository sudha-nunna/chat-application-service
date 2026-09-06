/**
 * followUpService.js
 * Generates 3 context-aware, engaging follow-up suggestion questions
 * after every AI response (similar to ChatGPT and OpenWebUI).
 *
 * Uses the active serving cluster node for dynamic generation with strict
 * 3.5s timeouts and resilient contextual heuristic fallbacks.
 */

const { selectBestClusterNode, clusterState } = require("../utils/ollamaHelper");

const FOLLOW_UP_TIMEOUT_MS = 5000;

/**
 * Intelligent contextual fallback generator if auxiliary LLM call times out, is offline, or returns invalid format.
 */
function getHeuristicFollowUps(userPrompt, assistantResponse) {
  const text = `${userPrompt || ""} ${assistantResponse || ""}`.toLowerCase();

  if (/(\bcode\b|\bfunction\b|\bcomponent\b|\berror\b|\bbug\b|\bapi\b|\bdatabase\b|\bquery\b|\bcss\b|\bhtml\b|\breact\b|\bnode\b|\bpython\b|\bjavascript\b|\btypescript\b)/i.test(text)) {
    return [
      "Can you show a complete code example?",
      "How do I handle errors and edge cases for this?",
      "What are the best practices and optimizations?"
    ];
  }

  if (/(\bwhy\b|\bhow does\b|\bexplain\b|\bconcept\b|\btheory\b|\bdifference\b|\bcompare\b|\barchitecture\b)/i.test(text)) {
    return [
      "Can you give a real-world analogy for this?",
      "What are the main pros and cons?",
      "What should I learn or explore next?"
    ];
  }

  if (/(\bhistory\b|\bwho\b|\bwhat is\b|\bwhen\b|\bwhere\b|\bevent\b|\bnews\b|\bperson\b|\bcountry\b)/i.test(text)) {
    return [
      "What are the most significant developments related to this?",
      "What impact does this have today?",
      "Can you provide a timeline of key milestones?"
    ];
  }

  if (/(\bplan\b|\bstrategy\b|\bguide\b|\btutorial\b|\bstep\b|\bhow to\b|\bdeploy\b|\binstall\b)/i.test(text)) {
    return [
      "What are the common pitfalls to avoid?",
      "What tools or prerequisites are recommended?",
      "How can I test or verify this is working?"
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
 * Handles:
 * 1. Strict JSON array: ["q1", "q2", "q3"]
 * 2. Markdown-wrapped JSON: ```json [...] ```
 * 3. Numbered lists: 1. Question? \n 2. Question? \n 3. Question?
 * 4. Bullet lists: - Question? \n - Question? \n - Question?
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

  // 2. Resilient fallback: parse line-by-line (numbered or bulleted questions)
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
 *
 * @param {string} userPrompt
 * @param {string} assistantResponse
 * @param {object} [options={}] - Optional node/model routing metadata
 * @returns {Promise<string[]>} Array of exactly 3 follow-up question strings
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

  // If cluster state is not yet loaded, lazily refresh from DB
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
    return getHeuristicFollowUps(cleanUser, cleanAssistant);
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
    const cleanUrl = (node.url || "").replace(/\/+$/, "");
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
      : (node.defaultModel || "glm-5.3-flash:cloud");

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
          num_predict: 250
        }
      };
    } else {
      requestBody = {
        model: targetModel,
        messages,
        temperature: 0.7,
        max_tokens: 250,
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
        // If we got 2 valid questions, pad with 1 smart contextual question to ensure exactly 3
        if (extracted.length === 2) {
          const fallbacks = getHeuristicFollowUps(cleanUser, cleanAssistant);
          const additional = fallbacks.find(f => !extracted.includes(f)) || "What would you recommend doing next?";
          extracted.push(additional);
        }
        console.log(`✨ [FOLLOW-UPS GENERATED DYNAMICALLY VIA AI] (${targetModel}):`, extracted);
        return extracted.slice(0, 3);
      }
    }
  } catch (err) {
    console.warn("⚠️ [FOLLOW-UP SUGGESTIONS] Auxiliary LLM generation notice:", err.message, "-> using smart heuristic fallback");
  }

  return getHeuristicFollowUps(cleanUser, cleanAssistant);
}

module.exports = {
  generateFollowUps,
  getHeuristicFollowUps,
  extractQuestions
};

