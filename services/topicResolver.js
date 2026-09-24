/**
 * topicResolver.js
 * Topic Normalization Layer.
 * Normalizes user prompts (e.g. "BTC", "Bitcoin", "Bitcoin News", "Bitcoin Market Updates")
 * into a canonical normalizedTopic string (e.g. "bitcoin").
 * Maximizes cache hit rates across different users and prevents duplicate AI generation.
 */

function normalizeTopic(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== "string") return "general_update";

  let clean = rawPrompt.trim().toLowerCase();

  // Strip question starters, verbs, filler commands, and time frequency words
  clean = clean.replace(/^(hey|hi|hello|please|can you|could you|would you|i want|i need|tell|explain|show|give|describe|search|find|create|generate|write|provide|get|fetch)\s+/gi, "");
  clean = clean.replace(/^(me|us|about|for|in|on|with|regarding|details|info|information|latest|today|todays|daily|every morning|every day|every week|weekly|hourly|every hour|now|current|recent|realtime)\s+/gi, "");
  clean = clean.replace(/\s+(today|todays|daily|every morning|every day|every week|weekly|hourly|every hour|now|current|recent|updates|update|news|summary|briefing|report)\b/gi, "");
  clean = clean.replace(/[?!.,;:"'`]+/g, "").trim();

  // Keyword Alias Mapping Rules
  if (/\b(btc|bitcoin)\b/i.test(clean)) return "bitcoin";
  if (/\b(eth|ethereum)\b/i.test(clean)) return "ethereum";
  if (/\b(sol|solana)\b/i.test(clean)) return "solana";
  if (/\b(crypto|cryptocurrency)\b/i.test(clean)) return "crypto_market";
  if (/\b(gold|gold rate|gold price)\b/i.test(clean)) return "gold_rate";
  if (/\b(silver|silver rate|silver price)\b/i.test(clean)) return "silver_rate";
  if (/\b(nifty|nifty 50|nifty50)\b/i.test(clean)) return "nifty50";
  if (/\b(sensex|bse sensex)\b/i.test(clean)) return "sensex";
  if (/\b(stock|stocks|stock market)\b/i.test(clean)) return "stock_market";
  if (/\b(usd\/inr|usdinr|dollar rate|usd inr)\b/i.test(clean)) return "usd_inr";
  if (/\b(ai|artificial intelligence|ai news|ai industry|ai agent|ai models)\b/i.test(clean)) return "ai_news";
  if (/\b(openai|chatgpt|gpt4|gpt5|sam altman)\b/i.test(clean)) return "openai_updates";
  if (/\b(google ai|gemini|deepmind)\b/i.test(clean)) return "google_ai";
  if (/\b(tech|technology|software|dev|coding|frontend|backend)\b/i.test(clean)) return "tech_news";
  if (/\b(slack|slack summary|slack channel)\b/i.test(clean)) return "slack_summary";
  if (/\b(github|github pr|github repo|github summary)\b/i.test(clean)) return "github_summary";
  if (/\b(jira|jira tickets|jira project)\b/i.test(clean)) return "jira_summary";
  if (/\b(calendar|google calendar|agenda|meeting)\b/i.test(clean)) return "calendar_agenda";

  // Fallback: take first 3 clean words or default to sanitized string
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words.slice(0, 3).join("_");
  }

  return "custom_topic";
}

module.exports = {
  normalizeTopic,
};
