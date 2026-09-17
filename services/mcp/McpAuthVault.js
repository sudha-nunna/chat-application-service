const crypto = require("crypto");
const UserMcpToken = require("../../models/UserMcpToken");

const ALGORITHM = "aes-256-gcm";

// Helper to get 32-byte cipher key
const getSecretKey = () => {
  const secret = process.env.MCP_ENCRYPTION_SECRET || process.env.ENCRYPTION_KEY || "default_mcp_secret_key_32_bytes_long!!";
  return crypto.createHash("sha256").update(String(secret)).digest();
};

/**
 * Encrypts a plain text token using AES-256-GCM.
 */
const encryptToken = (text) => {
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getSecretKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
};

/**
 * Decrypts an AES-256-GCM token payload.
 */
const decryptToken = (cipherText) => {
  if (!cipherText) return "";
  const parts = cipherText.split(":");
  if (parts.length !== 3) return cipherText; // Fallback if plain text
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, getSecretKey(), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

// In-memory OAuth state cache (10 min TTL)
const stateStore = new Map();

/**
 * Generates an OAuth CSRF state token bound to a user ID.
 */
const generateOAuthState = (userId) => {
  const state = crypto.randomBytes(32).toString("hex");
  stateStore.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
  return state;
};

/**
 * Validates an incoming OAuth state token.
 */
const validateOAuthState = (state) => {
  if (!state || !stateStore.has(state)) return null;
  const data = stateStore.get(state);
  stateStore.delete(state);
  if (Date.now() > data.expiresAt) return null;
  return data.userId;
};

/**
 * Stores or updates a user's MCP token record.
 */
const saveUserToken = async ({ userId, provider, teamId, teamName, userSlackId, accessToken, userAccessToken = "", refreshToken = "", scope = "", expiresAt = null }) => {
  const encryptedAccessToken = encryptToken(accessToken);
  const encryptedUserAccessToken = userAccessToken ? encryptToken(userAccessToken) : "";
  const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : "";

  const updateData = {
    teamId,
    teamName,
    userSlackId,
    encryptedAccessToken,
    scope,
    connectedAt: new Date(),
  };

  if (encryptedUserAccessToken) {
    updateData.encryptedUserAccessToken = encryptedUserAccessToken;
  }
  if (encryptedRefreshToken) {
    updateData.encryptedRefreshToken = encryptedRefreshToken;
  }
  if (expiresAt) {
    updateData.expiresAt = expiresAt;
  }

  const tokenRecord = await UserMcpToken.findOneAndUpdate(
    { userId, provider },
    { $set: updateData },
    { new: true, upsert: true }
  );

  return tokenRecord;
};

/**
 * Retrieves valid decrypted access token for a user and provider.
 * Performs optional refresh token rotation if refreshToken is present and near expiry.
 */
const getValidAccessToken = async (userId, provider = "slack") => {
  const record = await UserMcpToken.findOne({ userId, provider });
  if (!record) return null;

  // Optional token refresh check
  if (record.encryptedRefreshToken && record.expiresAt && Date.now() >= new Date(record.expiresAt).getTime() - 5 * 60 * 1000) {
    const plainRefreshToken = decryptToken(record.encryptedRefreshToken);
    if (plainRefreshToken && provider === "slack") {
      try {
        const refreshRes = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.SLACK_CLIENT_ID,
            client_secret: process.env.SLACK_CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: plainRefreshToken,
          }),
        });

        const refreshData = await refreshRes.json();
        if (refreshData.ok) {
          record.encryptedAccessToken = encryptToken(refreshData.access_token);
          if (refreshData.authed_user?.access_token) {
            record.encryptedUserAccessToken = encryptToken(refreshData.authed_user.access_token);
          }
          if (refreshData.refresh_token) {
            record.encryptedRefreshToken = encryptToken(refreshData.refresh_token);
          }
          if (refreshData.expires_in) {
            record.expiresAt = new Date(Date.now() + refreshData.expires_in * 1000);
          }
          await record.save();
        }
      } catch (err) {
        console.error("Failed to auto-refresh Slack OAuth token:", err.message);
      }
    }
  }

  const decryptedToken = decryptToken(record.encryptedAccessToken);
  const decryptedUserToken = record.encryptedUserAccessToken ? decryptToken(record.encryptedUserAccessToken) : "";
  return {
    accessToken: decryptedToken,
    userAccessToken: decryptedUserToken,
    teamId: record.teamId,
    teamName: record.teamName,
    userSlackId: record.userSlackId,
    scope: record.scope,
    connectedAt: record.connectedAt,
  };
};

/**
 * Removes user token record.
 */
const disconnectUserToken = async (userId, provider = "slack") => {
  const record = await UserMcpToken.findOneAndDelete({ userId, provider });
  return !!record;
};

module.exports = {
  encryptToken,
  decryptToken,
  generateOAuthState,
  validateOAuthState,
  saveUserToken,
  getValidAccessToken,
  disconnectUserToken,
};
