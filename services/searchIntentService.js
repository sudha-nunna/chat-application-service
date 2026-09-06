/**
 * searchIntentService.js
 * High-performance, synchronous rule-based guardrail for Web Search.
 * Evaluates in < 0.1ms in CPU memory with zero network calls and zero extra LLM overhead.
 *
 * Prevents unnecessary searches for greetings, trivial acknowledgements, continuation
 * tokens, and simple math, while reliably honoring Search for fresh, time-sensitive,
 * or non-trivial informational requests.
 */

// 1. Definite trivial greetings, acknowledgements, and system pings
const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|heya|hiya|howdy|sup|yo|good\s*(morning|afternoon|evening|night|day))\b/i,
  /^(thanks|thank\s*you|thx|ty|many\s*thanks|ok|okay|k|cool|great|awesome|nice|good|perfect|understood|got\s*it|alright|sure|yep|nope)\b/i,
  /^(who\s*are\s*you|what\s*is\s*your\s*name|what\s*can\s*you\s*do|who\s*created\s*you|are\s*you\s*an?\s*ai)\b/i,
  /^(test|testing|ping|pong|echo|hello\s*world)\b/i,
  /^(bye|goodbye|see\s*you|cya|talk\s*to\s*you\s*later)\b/i
];

// 2. Short conversational continuation and follow-up prompts
const CONTINUATION_PATTERNS = [
  /^(yes|no|yeah|nah|yup|nope|sure|definitely|of\s*course)\b/i,
  /^(\d+|option\s*\d+|choice\s*\d+|number\s*\d+)$/i,
  /^(continue|next|more|tell\s*me\s*more|explain\s*more|go\s*on|proceed|elaborate|keep\s*going|keep\s*writing)\b/i,
  /^(why\??|how\??|what\s*else\??|what\s*about\s*you\??|give\s*me\s*an?\s*example\??|example\s*please)\b/i
];

// 3. Simple arithmetic patterns (e.g., 2+2, 5*10, 100 / 4)
const ARITHMETIC_PATTERN = /^[\d\s\+\-\*\/\^\(\)\.%=]+$/;

// 4. Time-sensitive, live data, and freshness keywords
const FRESHNESS_KEYWORDS = [
  /\b(today|yesterday|tomorrow|tonight|currently|current|latest|newest|recent|recently|breaking\s*news)\b/i,
  /\b(weather|temperature|forecast|climate)\b/i,
  /\b(stock\s*price|stock|stocks|nasdaq|crypto|bitcoin|btc|eth|exchange\s*rate|usd|eur|inr|gold\s*rate)\b/i,
  /\b(who\s*won|score|scores|standing|standings|match|championship|super\s*bowl|olympics|world\s*cup|election|results)\b/i,
  /\b(2024|2025|2026|2027)\b/,
  /\b(release\s*date|changelog|patch\s*notes|version\s*\d+|update)\b/i,
  /\b(search\s*for|browse|look\s*up|google|find\s*online)\b/i
];

/**
 * Evaluates whether a query requires web search context injection.
 *
 * @param {string} prompt - Raw user prompt text
 * @param {boolean} enableSearch - Whether the Search toggle is enabled
 * @param {object} [context={}] - Optional context ({ hasHistory: boolean })
 * @returns {{ shouldSearch: boolean, reason: string }}
 */
function evaluateSearchIntent(prompt, enableSearch, context = {}) {
  // 1. Search toggle is OFF -> Never execute search
  if (!enableSearch) {
    return { shouldSearch: false, reason: "toggle_disabled" };
  }

  // 2. Empty prompt -> Skip
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { shouldSearch: false, reason: "empty_prompt" };
  }

  const clean = prompt.trim();

  // 3. URL detected -> Always fetch target webpage content
  if (/https?:\/\/[^\s]+/i.test(clean)) {
    return { shouldSearch: true, reason: "url_detected" };
  }

  // 4. Simple arithmetic check (e.g. "2+2", "5 * 10", "120 / 4")
  if (clean.length <= 25 && ARITHMETIC_PATTERN.test(clean) && /[\+\-\*\/]/.test(clean)) {
    return { shouldSearch: false, reason: "simple_arithmetic" };
  }

  // 5. Explicit freshness, news, or live keywords
  for (const regex of FRESHNESS_KEYWORDS) {
    if (regex.test(clean)) {
      return { shouldSearch: true, reason: "freshness_keyword" };
    }
  }

  // 6. Clean word count & normalized text for conversational checks
  const words = clean.split(/\s+/);
  const normalized = clean.toLowerCase().replace(/[^\w\s]/g, "").trim();

  // 7. Check trivial greetings / acknowledgements / pings (1 to 4 words)
  if (words.length <= 4) {
    for (const regex of TRIVIAL_PATTERNS) {
      if (regex.test(normalized) || regex.test(clean)) {
        return { shouldSearch: false, reason: "trivial_greeting" };
      }
    }

    // 8. Check short follow-up / continuation tokens
    for (const regex of CONTINUATION_PATTERNS) {
      if (regex.test(normalized) || regex.test(clean)) {
        return { shouldSearch: false, reason: "conversation_continuation" };
      }
    }

    // Single word token with no freshness keywords (e.g., "why", "code", "run")
    if (words.length === 1 && !FRESHNESS_KEYWORDS.some(rx => rx.test(clean))) {
      return { shouldSearch: false, reason: "single_word_non_search" };
    }
  }

  // 9. All guardrails passed and Search toggle is ON -> Honor user's explicit search request
  return { shouldSearch: true, reason: "user_toggle_enabled" };
}

/**
 * Convenience helper returning boolean
 */
function shouldSearch(prompt, enableSearch, context = {}) {
  return evaluateSearchIntent(prompt, enableSearch, context).shouldSearch;
}

module.exports = {
  evaluateSearchIntent,
  shouldSearch
};
