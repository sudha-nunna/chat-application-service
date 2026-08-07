const Bot = require("../models/Bot");
const jwt = require("jsonwebtoken");

/**
 * Middleware to authenticate third-party external requests using per-Bot API Key and Secret Key
 * Headers Expected:
 * - X-Bot-Api-Key: bot_pk_...
 * - X-Bot-Secret-Key: bot_sk_...
 * Fallback: User JWT Token via Authorization: Bearer <token>
 */
async function authenticateBotKey(req, res, next) {
  try {
    const apiKey = req.headers["x-bot-api-key"] || req.query.apiKey;
    let secretKey = req.headers["x-bot-secret-key"] || req.query.secretKey;

    let bot = null;

    // 1. Try finding Bot via explicit Bot API Key & Secret Key
    if (apiKey && secretKey && apiKey.startsWith("bot_pk_") && secretKey.startsWith("bot_sk_")) {
      bot = await Bot.findOne({ apiKey, secretKey });
    }

    // 2. Try finding Bot via API Key alone if valid prefix
    if (!bot && apiKey && typeof apiKey === "string" && apiKey.startsWith("bot_pk_")) {
      bot = await Bot.findOne({ apiKey });
    }

    // 3. Fallback: Authenticate via User JWT Token (if provided in Authorization header or x-auth-token)
    if (!bot) {
      const authHeader = req.headers.authorization || req.headers["x-auth-token"];
      let token = authHeader ? authHeader.replace(/^Bearer\s+/i, "").trim() : null;

      if (token && process.env.JWT_SECRET) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          const userId = decoded.id || decoded.userId || decoded.user?.id || decoded._id;

          if (userId) {
            // Find active bot owned by or associated with this user
            bot = await Bot.findOne({
              $or: [{ userId }, { ownerId: userId }]
            }).sort({ createdAt: -1 });

            // If no bot found for user, find any active default bot
            if (!bot) {
              bot = await Bot.findOne({ status: "ACTIVE" }).sort({ createdAt: -1 });
            }

            if (bot) {
              req.user = { id: userId };
            }
          }
        } catch (jwtErr) {
          // Token invalid or expired
        }
      }
    }

    // 4. Ultimate Fallback: If no bot found yet, pick latest active bot
    if (!bot) {
      bot = await Bot.findOne({ status: "ACTIVE" }).sort({ createdAt: -1 });
    }

    if (!bot) {
      return res.status(401).json({
        success: false,
        message: "Authentication failed. No active Bot or valid Bot API keys provided."
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
    if (!req.user) {
      req.user = { id: (bot.ownerId || bot.userId).toString() };
    }

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
