/**
 * followUpService.js
 * Generates 3 context-aware, engaging follow-up suggestion questions
 * after every AI response (similar to ChatGPT and OpenWebUI).
 *
 * Uses intelligent contextual heuristics (<1ms latency) with an optional ultra-fast
 * sub-second LLM race (max 800ms timeout) so the user never experiences delays.
 */

const { selectBestClusterNode, clusterState } = require("../utils/ollamaHelper");

// 3000ms cap to allow active LLM server node to return dynamic follow-up questions
const FOLLOW_UP_TIMEOUT_MS = 3000;

/**
 * Extracts a clean topic name from user prompt without filler words, pronouns, or extra prepositions.
 */
function extractCleanTopic(prompt) {
  if (!prompt || typeof prompt !== "string") return "";
  let clean = prompt.trim();

  // Strip question starters and filler commands
  clean = clean.replace(/^(hey|hi|hello|please|can you|could you|would you|i want to|i need to|tell|explain|show|give|describe|search|find|create|build|make|design|generate|write|develop|implement|add|construct|render|draft|setup|set up|code|style|draw)\s+/i, "");
  clean = clean.replace(/^(me|us|him|her|it|them|to me|to us|for me)\s+/i, "");
  clean = clean.replace(/^(about|for|in|on|with|regarding|concerning|information about|info about|details about|more about)\s+/i, "");
  clean = clean.replace(/^(full form of|fullform of|meaning of|definition of|abbreviation of|what is full form of|what is the full form of|what does|what do|what is|what are|who is|who was|where is|why is|how does|how to|difference between)\s+/i, "");
  clean = clean.replace(/\s+(stand for|stands for)\b/i, "");
  clean = clean.replace(/^(a|an|the|this|that|these|those|my|your|his|her|its|our|their|one|some|any)\s+/i, "");

  // Strip prepositions and trailing clauses from multi-word topics
  clean = clean.replace(/\s+(for|to|in|with|using|on|by|of|about)\b.*/i, "");

  // Strip trailing punctuation
  clean = clean.replace(/[?!.,;:\"\`]+$/g, "").trim();

  // Strip residual leading prepositions/pronouns/verbs/articles
  clean = clean.replace(/^(me|us|him|her|it|them|about|for|on|in|with|to)\s+/i, "").trim();
  clean = clean.replace(/^(a|an|the|this|that|these|those|my|your|one|some|full form)\s+/i, "").trim();
  clean = clean.replace(/^(design|create|build|make|generate|write|develop|implement|add)\s+/i, "").trim();

  if (/^(image|photo|picture|file|document|attachment|this image|this photo)$/i.test(clean)) {
    return "this image";
  }

  // If topic is still multiple words, keep the first 3 key words
  const words = clean.split(/\s+/);
  if (words.length > 3) {
    clean = words.slice(0, 3).join(" ");
  }

  // Blacklist invalid topics: verbs/participles (-ing words), filler words, generic pronouns
  const isInvalidTopic = /^(me|us|it|this|that|what|how|why|one|some|here|there|saying|doing|going|talking|asking|telling|being|getting|having|making|full form|form|say|do|go|get|be|have|make)$/i.test(clean) ||
    (/ing$/i.test(clean) && !/^(programming|landing|learning|banking|caching|testing|debugging|housing|mining|imaging|tracking|routing|shopping|billing)$/i.test(clean));

  if (clean.length >= 2 && clean.length <= 30 && !isInvalidTopic) {
    return clean;
  }

  return "";
}

/**
 * High-performance smart contextual follow-up question generator.
 * Operates in <1ms without network overhead.
 */
function getSmartFollowUps(userPrompt, assistantResponse) {
  const prompt = (userPrompt || "").trim();
  const response = (assistantResponse || "").trim();
  const promptLower = prompt.toLowerCase();
  const combined = `${prompt} ${response}`.toLowerCase();
  const topic = extractCleanTopic(prompt);

  // 0. Greetings & Casual Chat Starters (Punctuation and Whitespace check ensures ONLY pure greetings match)
  const isPureGreeting = /^(hey|hi|hello|greetings|good morning|good afternoon|good evening|hey there|hi there|howdy|sup)[\s!.,?]*$/i.test(promptLower);
  if (isPureGreeting) {
    return [
      "What can you help me build today?",
      "What are your core capabilities and features?",
      "Can you give an example of what we can create?"
    ];
  }

  // 1. Security / OTP / Authentication / 2FA queries
  if (/\b(otp|one time password|2fa|mfa|verification code)\b/i.test(promptLower)) {
    return [
      "How does OTP verification work in 2FA security?",
      "What are best practices for sending secure OTPs via SMS or email?",
      "How do TOTP apps like Google Authenticator differ from SMS OTP?"
    ];
  }

  // 2. Slack / Messaging action queries (STRICT MATCH: require user's prompt to explicitly ask about Slack)
  const isUserSlackQuery = /(\bslack\b|\bslack workspace\b|\bslack channel\b|\bpost to slack\b|\bsend to slack\b|\bcheck slack\b|\blist slack\b|\bconnect slack\b)/i.test(promptLower);

  if (isUserSlackQuery) {
    const channelMatch = combined.match(/#(general|random|announcements|dev|design|support|help|team|tech|chat)\b/i);
    const targetName = channelMatch ? channelMatch[0] : "Slack";
    return [
      `Check recent messages in ${targetName}`,
      `Send another message to ${targetName}`,
      `List available Slack channels & members`
    ];
  }

  // 3. UI / Web Design / Frontend / Landing & Login Pages / Components
  // Strictly prevent "full form" or "form of" from matching web design forms
  const isUiWebDesign = /(\blogin page\b|\blanding page\b|\bsignup page\b|\bregister page\b|\bauth page\b|\bui form\b|\bweb form\b|\binput form\b|\bform validation\b|\bcard component\b|\bnavbar\b|\bsidebar\b|\bdashboard\b|\bui design\b|\bux design\b|\bfrontend\b|\bcss styling\b|\btailwind\b|\bhtml layout\b|\bweb page\b|\bwebsite design\b|\bhero section\b|\bbutton style\b|\bmodal popup\b|\bdark mode\b|\bresponsive layout\b)/i.test(promptLower);

  if (isUiWebDesign) {
    // Subcategory: Login / Signup / Authentication pages
    if (/(\blogin\b|\bsignup\b|\bregister\b|\bauth\b|\bauthentication\b|\bform validation\b)/i.test(promptLower)) {
      return [
        "Can you add form validation and password show/hide toggle?",
        "How do I connect this form to an authentication backend API?",
        "Can you design a matching signup/registration page?"
      ];
    }

    // Subcategory: Landing page / Hero section / Full websites
    if (/(\blanding page\b|\bhero section\b|\bhomepage\b|\bportfolio\b|\bwebsite\b)/i.test(promptLower)) {
      return [
        "Can you add a features grid, pricing table, and footer?",
        "How can I make this layout fully responsive for mobile screens?",
        "Can you convert this design into a React or Next.js component?"
      ];
    }

    // Subcategory: General UI / Components / CSS / Tailwind
    return [
      "Can you add responsive dark mode styling?",
      "How can I add smooth micro-animations and hover effects?",
      topic ? `Can you convert ${topic} into a reusable React component?` : "Can you convert this design into a reusable React component?"
    ];
  }

  // 4. Vision / Photo queries
  if (topic === "this image" || /(\bimage\b|\bphoto\b|\bpicture\b|\bscreenshot\b|\bdiagram\b|\bgraphic\b)/i.test(promptLower)) {
    return [
      "Can you explain more details about this image?",
      "What are the key elements or objects visible here?",
      "How does this compare to standard examples?"
    ];
  }

  // 5. Math / Calculations / Numbers
  if (/(\d+\s*[\+\-\*\/=]\s*\d+|\bcalculate\b|\bformula\b|\bequation\b|\bsolve\b|\bmath\b|\balgebra\b|\bgeometry\b|\bcalculus\b)/i.test(promptLower)) {
    return [
      "Can you show the step-by-step calculations?",
      "Can you give another practice problem like this?",
      "What formula or mathematical rule was applied here?"
    ];
  }

  // 6. Coding / Technical / Software Development
  if (/(\bcode\b|\bfunction\b|\bcomponent\b|\berror\b|\bbug\b|\bapi\b|\bdatabase\b|\bquery\b|\breact\b|\bnode\b|\bpython\b|\bjavascript\b|\btypescript\b|\bgit\b|\bdocker\b|\bsql\b|\bbackend\b|\bendpoint\b|\bexpress\b)/i.test(promptLower)) {
    return [
      topic ? `Can you show a complete code example for ${topic}?` : "Can you show a complete code example?",
      topic ? `How do I handle errors and edge cases in ${topic}?` : "How do I handle errors and edge cases for this?",
      topic ? `What are best practices and optimizations for ${topic}?` : "What are the best practices and optimizations?"
    ];
  }

  // 7. Comparisons & Pros / Cons
  if (/(\bcompare\b|\bdifference\b|\bvs\b|\bversus\b|\balternative\b|\bpros and cons\b|\btradeoff\b|\bbenchmark\b)/i.test(promptLower)) {
    return [
      topic ? `What are the main trade-offs with ${topic}?` : "What are the main pros and cons?",
      "Which option is better for production use?",
      "Can you give a practical real-world scenario?"
    ];
  }

  // 8. Conceptual / Architectural / Deep Explanations
  if (/(\bwhy\b|\bhow does\b|\bexplain\b|\bconcept\b|\btheory\b|\barchitecture\b|\bunder the hood\b)/i.test(promptLower)) {
    return [
      topic ? `Can you give a real-world analogy for ${topic}?` : "Can you give a real-world analogy for this?",
      topic ? `What are common misconceptions about ${topic}?` : "What are common misconceptions about this?",
      "What should I explore or study next?"
    ];
  }

  // 9. Guides / How-to / Deployments / Tutorials
  if (/(\bhow to\b|\bguide\b|\btutorial\b|\bstep\b|\bdeploy\b|\binstall\b|\bsetup\b|\bconfig\b|\bconfigure\b)/i.test(promptLower)) {
    return [
      "What are common pitfalls or mistakes to avoid?",
      "What tools or prerequisites are recommended?",
      "How can I test or verify that this is working?"
    ];
  }

  // 10. Definitions / Meanings / Concepts / General Knowledge
  if (/(\bfull form\b|\babbreviation\b|\bmeaning\b|\bdefinition\b|\bhistory\b|\bwho is\b|\bwho was\b|\bwhen did\b|\bevent\b|\bnews\b|\bcity\b|\bwhat is\b)/i.test(promptLower) || (topic && topic.length >= 2)) {
    const topicLabel = topic || "this topic";
    return [
      `What are key details and main uses of ${topicLabel}?`,
      `What is the background or origin of ${topicLabel}?`,
      `Can you share practical examples or interesting facts about ${topicLabel}?`
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

  const prompt = `Based on this exact user prompt and AI response, generate 3 relevant, logical follow-up questions the user might ask next.

User Prompt: "${cleanUser}"
AI Response Summary: "${cleanAssistant.substring(0, 500)}"

RULES:
- Return ONLY a JSON array of 3 short question strings (e.g. ["Question 1?", "Question 2?", "Question 3?"]).
- Questions must directly relate to the user's specific topic or intent.
- If user prompt is a greeting like "hey" or "hi", generate general conversational questions (e.g. "What can you help me build today?", "What are your core capabilities?").
- No markdown formatting, no explanations, no numbering outside the JSON array.
- Each question under 75 characters.`;

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
    } else if (cleanUrl.includes("googleapis.com") || node.format === "gemini") {
      endpoint = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    } else if (isStandardOpenAi || node.format === "glm") {
      endpoint = cleanUrl.endsWith("/chat/completions")
        ? cleanUrl
        : cleanUrl.endsWith("/v1")
        ? `${cleanUrl}/chat/completions`
        : `${cleanUrl}/v1/chat/completions`;
    } else {
      endpoint = cleanUrl.endsWith("/api/chat") ? cleanUrl : `${cleanUrl}/api/chat`;
    }

    let resolvedApiKey = (node.secretKey && !/[\u2022\*]/.test(node.secretKey)) ? node.secretKey : "";
    if (resolvedApiKey) {
      try {
        const { decrypt } = require("../utils/encryption");
        const dec = decrypt(resolvedApiKey);
        if (dec) resolvedApiKey = dec;
      } catch (_) {}
    }

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
