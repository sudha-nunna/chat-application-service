const crypto = require("crypto");
const ApiKey = require("../models/ApiKey");
const User = require("../models/User");

// In-memory key cache to prevent database hits on every single API request (TTL: 60 seconds)
const keyCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

/**
 * Middleware for authenticating Public OpenAI-compatible API calls using Bearer API Keys.
 */
exports.authenticateApiKey = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: {
          message: "You must provide an API key in the Authorization header using 'Bearer <API_KEY>'.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }

    const rawKey = authHeader.split(" ")[1]?.trim();
    if (!rawKey) {
      return res.status(401).json({
        error: {
          message: "API key cannot be empty.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }

    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

    // 1. Check local fast cache
    const cached = keyCache.get(keyHash);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      if (cached.apiKey.status !== "ACTIVE") {
        return res.status(401).json({
          error: {
            message: "API key has been revoked.",
            type: "invalid_request_error",
            param: null,
            code: "key_revoked"
          }
        });
      }
      req.apiKey = cached.apiKey;
      req.user = cached.user;
      return next();
    }

    // 2. Query Database
    const apiKeyDoc = await ApiKey.findOne({ keyHash, status: "ACTIVE" });
    if (!apiKeyDoc) {
      return res.status(401).json({
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key"
        }
      });
    }

    const userDoc = await User.findById(apiKeyDoc.userId);
    if (!userDoc) {
      return res.status(401).json({
        error: {
          message: "User account associated with this API key was not found.",
          type: "invalid_request_error",
          param: null,
          code: "user_not_found"
        }
      });
    }

    // Cache valid lookup
    keyCache.set(keyHash, {
      apiKey: apiKeyDoc,
      user: userDoc,
      cachedAt: Date.now()
    });

    req.apiKey = apiKeyDoc;
    req.user = userDoc;

    // Asynchronously update lastUsedAt
    ApiKey.updateOne({ _id: apiKeyDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

    next();
  } catch (err) {
    return res.status(500).json({
      error: {
        message: "Internal authentication error.",
        type: "api_error",
        param: null,
        code: "internal_error"
      }
    });
  }
};

/**
 * Invalidate cache entry when a key is revoked
 */
exports.invalidateKeyCache = (rawKeyOrHash) => {
  if (rawKeyOrHash) {
    const keyHash = rawKeyOrHash.length === 64
      ? rawKeyOrHash
      : crypto.createHash("sha256").update(rawKeyOrHash).digest("hex");
    keyCache.delete(keyHash);
  }
};
