/**
 * sourceResolver.js
 * Automatic Natural Language Source Classification Layer.
 * Classifies a user prompt into:
 * - "market_data" (Bitcoin, Gold, Stocks, Sensex, Nifty) -> Direct API (0 AI cost)
 * - "mcp" (Slack, GitHub, Calendar, Jira, Gmail) -> Live MCP Adapter (No Cache)
 * - "news_summary" (AI news, Tech news, OpenAI updates) -> Search + AI Summary (6h Cache)
 * - "custom_query" (Research topics, custom queries) -> Search/Retrieval + AI Summary (24h Cache)
 */

function resolveSourceType(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== "string") return "custom_query";

  const promptLower = rawPrompt.trim().toLowerCase();

  // 1. Market Data (Crypto, Precious Metals, Stock Indices, Forex)
  const isMarketData = /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|crypto market|gold|gold rate|gold price|silver|silver rate|nifty|nifty50|sensex|stock market|stocks|usd\/inr|usdinr|dollar rate)\b/i.test(promptLower);
  if (isMarketData) return "market_data";

  // 2. MCP Integration Requests (Slack, GitHub, Calendar, Jira, Gmail)
  const isMcp = /\b(slack|slack channel|slack messages|github|github pr|github repo|calendar|google calendar|agenda|jira|jira tickets|gmail|unread emails)\b/i.test(promptLower);
  if (isMcp) return "mcp";

  // 3. News Summaries (AI news, Tech news, Startup news, Industry updates)
  const isNewsSummary = /\b(news|latest news|ai news|tech news|technology news|startup news|openai updates|industry news|daily briefing|weekly summary|headlines)\b/i.test(promptLower);
  if (isNewsSummary) return "news_summary";

  // Default fallback for user research topics
  return "custom_query";
}

module.exports = {
  resolveSourceType,
};
