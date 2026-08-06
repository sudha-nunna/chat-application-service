const Redis = require("ioredis");

// High-Performance Redis Client for In-Memory Caching (< 1ms latency)
const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: true,
  lazyConnect: false
});

redis.on("connect", () => {
  console.log("⚡ [REDIS CONNECTED] High-speed Redis connected on 127.0.0.1:6379");
});

redis.on("error", (err) => {
  console.warn("⚠️ [REDIS NOTICE]", err.message);
});

/**
 * Cache Helper: Get JSON or String from Redis
 */
async function getCache(key) {
  try {
    const data = await redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      return data;
    }
  } catch (err) {
    return null;
  }
}

/**
 * Cache Helper: Set Key with Expiry in Seconds
 */
async function setCache(key, value, ttlSeconds = 300) {
  try {
    const stringVal = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (ttlSeconds > 0) {
      await redis.set(key, stringVal, "EX", ttlSeconds);
    } else {
      await redis.set(key, stringVal);
    }
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Cache Helper: Delete Key or Pattern
 */
async function delCache(key) {
  try {
    await redis.del(key);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  redis,
  getCache,
  setCache,
  delCache
};
