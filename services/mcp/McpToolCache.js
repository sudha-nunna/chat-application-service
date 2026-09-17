class McpToolCache {
  constructor() {
    this.memoryCache = new Map(); // key -> { tools, expiresAt }
    this.defaultTtlMs = 15 * 60 * 1000; // 15 minutes
  }

  getCacheKey(userId, provider) {
    return `mcp_tools:${userId}:${provider}`;
  }

  async getCachedTools(userId, provider) {
    const key = this.getCacheKey(userId, provider);
    if (this.memoryCache.has(key)) {
      const entry = this.memoryCache.get(key);
      if (Date.now() < entry.expiresAt) {
        return entry.tools;
      }
      this.memoryCache.delete(key);
    }
    return null;
  }

  async setCachedTools(userId, provider, tools, ttlMs = this.defaultTtlMs) {
    const key = this.getCacheKey(userId, provider);
    this.memoryCache.set(key, {
      tools,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async invalidateUserCache(userId, provider) {
    const key = this.getCacheKey(userId, provider);
    this.memoryCache.delete(key);
  }
}

module.exports = new McpToolCache();
