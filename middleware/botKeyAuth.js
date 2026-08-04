const Bot = require("../models/Bot");

/**
 * Middleware to authenticate third-party external requests using per-Bot API Key and Secret Key
 * Headers Expected:
 * - X-Bot-Api-Key: bot_pk_...
 * - X-Bot-Secret-Key: bot_sk_... (or Authorization: Bearer bot_sk_...)
 */
async function authenticateBotKey(req, res, next) {
  try {
    const apiKey = req.headers["x-bot-api-key"] || req.query.apiKey;
    let secretKey = req.headers["x-bot-secret-key"] || req.query.secretKey;

    if (!secretKey && req.headers.authorization) {
      const authHeader = req.headers.authorization;
      if (authHeader.startsWith("Bearer ")) {
        secretKey = authHeader.split(" ")[1].trim();
      }
    }

    if (!apiKey || !secretKey) {
      return res.status(401).json({
        success: false,
        message: "Authentication failed. Required headers missing: 'X-Bot-Api-Key' and 'X-Bot-Secret-Key' (or Bearer Authorization token)."
      });
    }

    // Senior Production Validation: Validate key prefix structure
    if (typeof apiKey !== "string" || !apiKey.startsWith("bot_pk_") || typeof secretKey !== "string" || !secretKey.startsWith("bot_sk_")) {
      return res.status(400).json({
        success: false,
        message: "Invalid key format. Public API Key must start with 'bot_pk_' and Secret Key must start with 'bot_sk_'."
      });
    }

    const bot = await Bot.findOne({ apiKey, secretKey });
    if (!bot) {
      return res.status(401).json({
        success: false,
        message: "Authentication failed. Invalid Bot API Key or Secret Key."
      });
    }

    if (bot.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Forbidden. This Bot is currently INACTIVE. Please contact the bot owner to activate it."
      });
    }

    // Senior Security Origin Check: If bot owner configured allowedDomains, validate origin header
    const rawOrigin = (req.headers.origin || req.headers.referer || "").toLowerCase();
    if (bot.allowedDomains && Array.isArray(bot.allowedDomains) && bot.allowedDomains.length > 0) {
      const isAllowedOrigin = bot.allowedDomains.some(domain => {
        if (!domain || !domain.trim()) return false;
        const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
        return rawOrigin.includes(cleanDomain);
      });

      if (!isAllowedOrigin) {
        console.warn(`🛡️ [CORS SECURITY BLOCK] Origin '${rawOrigin}' rejected for Bot '${bot.name}' (${bot._id}). Allowed:`, bot.allowedDomains);
        return res.status(403).json({
          success: false,
          message: `Access denied. Origin domain '${rawOrigin || 'unknown'}' is not authorized to use this Bot API key.`
        });
      }
    }

    // Update last used timestamp in background
    bot.keyLastUsedAt = new Date();
    bot.save().catch(err => console.warn("Failed to update bot keyLastUsedAt:", err.message));

    req.bot = bot;
    req.user = { id: bot.ownerId || bot.userId };
    next();
  } catch (error) {
    console.error("Bot Key Auth Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during Bot API Key authentication.",
      error: error.message
    });
  }
}

module.exports = authenticateBotKey;
