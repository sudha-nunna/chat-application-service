/**
 * dynamicCacheService.js
 * Source-Specific Dynamic TTL Cache Layer.
 * Manages caching for generated intelligence content to eliminate duplicate AI & Search API costs.
 * 
 * Dynamic TTL Policies:
 * - market_data -> 10 minutes
 * - news_summary -> 360 minutes (6 hours)
 * - custom_query -> 1440 minutes (24 hours)
 * - mcp -> 0 minutes (No Cache / Live Execution)
 * - Max Hard Cap -> 14400 minutes (10 Days TTL auto-deletion in MongoDB)
 */

const IntelligenceCache = require("../models/IntelligenceCache");

const TTL_POLICY_MINUTES = {
  market_data: 10,
  news_summary: 360,
  custom_query: 1440,
  mcp: 0,
};

async function getCachedContent(normalizedTopic, sourceType) {
  if (sourceType === "mcp") return null; // Always fetch live data for MCP

  try {
    const cached = await IntelligenceCache.findOne({
      normalizedTopic,
      sourceType,
      expiresAt: { $gt: new Date() },
    });

    if (cached) {
      console.log(`⚡ [DYNAMIC CACHE HIT] Reusing cached summary for topic="${normalizedTopic}" sourceType="${sourceType}"`);
      return cached.content;
    }
  } catch (err) {
    console.warn("⚠️ [DYNAMIC CACHE WARNING] Cache lookup failed:", err.message);
  }

  return null;
}

async function setCachedContent(normalizedTopic, sourceType, content) {
  if (sourceType === "mcp" || !content) return;

  const ttlMinutes = TTL_POLICY_MINUTES[sourceType] || 360;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  try {
    await IntelligenceCache.findOneAndUpdate(
      { normalizedTopic, sourceType },
      {
        content,
        ttlMinutes,
        generatedAt: now,
        expiresAt,
      },
      { upsert: true, new: true }
    );
    console.log(`💾 [DYNAMIC CACHE STORED] Topic="${normalizedTopic}" (TTL: ${ttlMinutes}m)`);
  } catch (err) {
    console.warn("⚠️ [DYNAMIC CACHE WARNING] Failed to store cache:", err.message);
  }
}

module.exports = {
  getCachedContent,
  setCachedContent,
  TTL_POLICY_MINUTES,
};
