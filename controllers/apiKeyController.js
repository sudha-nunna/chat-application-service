const crypto = require("crypto");
const ApiKey = require("../models/ApiKey");
const ApiKeyUsage = require("../models/ApiKeyUsage");
const { invalidateKeyCache } = require("../middleware/apiKeyAuth");

/**
 * Generate a new API Key for the authenticated user.
 */
exports.createApiKey = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ success: false, message: "API key name is required." });
    }

    const userId = req.user.id || req.user._id;

    // Limit max active keys per user (e.g. 10 keys)
    const existingCount = await ApiKey.countDocuments({ userId, status: "ACTIVE" });
    if (existingCount >= 10) {
      return res.status(400).json({
        success: false,
        message: "Maximum active API key limit (10) reached. Please revoke an existing key before creating a new one."
      });
    }

    // Generate cryptographically strong key: cg-live-<32 hex chars>
    const randomBytes = crypto.randomBytes(16).toString("hex");
    const secretKey = `cg-live-${randomBytes}`;
    const keyPrefix = `${secretKey.substring(0, 12)}...`;
    const keyHash = crypto.createHash("sha256").update(secretKey).digest("hex");

    const apiKeyDoc = await ApiKey.create({
      userId,
      name: name.trim(),
      keyPrefix,
      keyHash,
      status: "ACTIVE"
    });

    return res.status(201).json({
      success: true,
      apiKey: {
        id: apiKeyDoc._id,
        name: apiKeyDoc.name,
        keyPrefix: apiKeyDoc.keyPrefix,
        secretKey, // Returned ONLY ONCE upon creation
        createdAt: apiKeyDoc.createdAt
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * List all API Keys for the authenticated user.
 */
exports.getApiKeys = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const keys = await ApiKey.find({ userId }).sort({ createdAt: -1 });

    const sanitizedKeys = keys.map((k) => ({
      id: k._id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      status: k.status,
      rateLimitRPM: k.rateLimitRPM,
      lastUsedAt: k.lastUsedAt,
      totalRequests: k.totalRequests,
      totalTokensUsed: k.totalTokensUsed,
      totalCreditsSpent: k.totalCreditsSpent,
      createdAt: k.createdAt
    }));

    return res.json({ success: true, apiKeys: sanitizedKeys });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Revoke an API Key.
 */
exports.revokeApiKey = async (req, res) => {
  try {
    const { keyId } = req.params;
    const userId = req.user.id || req.user._id;

    const apiKeyDoc = await ApiKey.findOne({ _id: keyId, userId });
    if (!apiKeyDoc) {
      return res.status(404).json({ success: false, message: "API Key not found or unauthorized." });
    }

    apiKeyDoc.status = "REVOKED";
    await apiKeyDoc.save();

    invalidateKeyCache(apiKeyDoc.keyHash);

    return res.json({ success: true, message: "API key successfully revoked." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Get usage analytics for a specific API Key.
 */
exports.getApiKeyStats = async (req, res) => {
  try {
    const { keyId } = req.params;
    const userId = req.user.id || req.user._id;

    const apiKeyDoc = await ApiKey.findOne({ _id: keyId, userId });
    if (!apiKeyDoc) {
      return res.status(404).json({ success: false, message: "API Key not found." });
    }

    const usageRecords = await ApiKeyUsage.find({ apiKeyId: keyId })
      .sort({ date: -1 })
      .limit(30);

    return res.json({
      success: true,
      apiKey: {
        id: apiKeyDoc._id,
        name: apiKeyDoc.name,
        keyPrefix: apiKeyDoc.keyPrefix,
        totalRequests: apiKeyDoc.totalRequests,
        totalTokensUsed: apiKeyDoc.totalTokensUsed,
        totalCreditsSpent: apiKeyDoc.totalCreditsSpent
      },
      dailyUsage: usageRecords
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
