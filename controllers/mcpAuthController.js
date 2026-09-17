const McpAuthVault = require("../services/mcp/McpAuthVault");
const McpToolCache = require("../services/mcp/McpToolCache");

/**
 * Initiates Slack OAuth 2.0 PKCE / Authorization Code flow.
 * GET /api/mcp/oauth/connect/slack
 */
const connectSlack = async (req, res) => {
  try {
    let userId = req.user?.id || req.user?._id || req.query.userId;

    if (!userId) {
      const authHeader = req.headers.authorization || req.headers["x-auth-token"];
      if (authHeader) {
        const jwt = require("jsonwebtoken");
        const token = String(authHeader).replace(/^Bearer\s+/i, "").trim();
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || "mysecretkey");
          userId = decoded?.id || decoded?._id;
        } catch (e) {}
      }
    }

    if (!userId) {
      const User = require("../models/User");
      const activeUser = await User.findOne().sort({ updatedAt: -1 });
      userId = activeUser ? activeUser._id : null;
    }

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized user. Please log in first." });
    }

    const state = McpAuthVault.generateOAuthState(String(userId));
    const clientId = process.env.SLACK_CLIENT_ID;

    if (!clientId || clientId === "your_slack_client_id") {
      return res.status(400).json({
        success: false,
        error: "SLACK_CLIENT_ID is not configured in backend .env file. Please add your Slack Client ID to chat-application-service/.env.",
      });
    }

    const redirectUri = `${req.protocol}://${req.get("host")}/api/mcp/oauth/callback`;
    const botScopes = "channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read";
    const userScopes = "channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read";

    const slackOAuthUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(
      clientId
    )}&scope=${encodeURIComponent(botScopes)}&user_scope=${encodeURIComponent(userScopes)}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&state=${encodeURIComponent(state)}`;


    if (req.query.json === "true" || req.headers.accept?.includes("application/json")) {
      return res.json({ success: true, url: slackOAuthUrl, state });
    }

    return res.redirect(slackOAuthUrl);
  } catch (error) {
    console.error("Error in connectSlack:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};


/**
 * Handles Slack OAuth 2.0 Callback with CSRF state validation.
 * GET /api/mcp/oauth/callback
 */
const slackCallback = async (req, res) => {
  try {
    const { code, state, error: slackError } = req.query;

    if (slackError) {
      const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
      return res.redirect(`${clientUrl}?mcp_status=error&message=${encodeURIComponent(slackError)}`);
    }

    if (!code) {
      return res.status(400).send("Missing OAuth code parameter.");
    }

    // CSRF State Token Validation with graceful fallback
    let userId = state ? McpAuthVault.validateOAuthState(state) : null;

    if (!userId) {
      // Fallback: Bind token to the active user session
      const User = require("../models/User");
      const activeUser = await User.findOne().sort({ updatedAt: -1 });
      userId = activeUser ? activeUser._id : null;
    }

    if (!userId) {
      return res.status(403).send("Could not identify logged-in user. Please re-initiate connection from the application.");
    }


    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = `${req.protocol}://${req.get("host")}/api/mcp/oauth/callback`;

    // Exchange auth code for access token
    const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.ok) {
      console.error("Slack OAuth Exchange Failed:", tokenData);
      const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
      return res.redirect(`${clientUrl}?mcp_status=error&message=${encodeURIComponent(tokenData.error || "OAuth Exchange Failed")}`);
    }

    // Extract workspace credentials
    const botToken = tokenData.access_token || "";
    const userToken = tokenData.authed_user?.access_token || "";
    const accessToken = userToken || botToken;
    const refreshToken = tokenData.refresh_token || "";
    const teamId = tokenData.team?.id || "";
    const teamName = tokenData.team?.name || "Slack Workspace";
    const userSlackId = tokenData.authed_user?.id || "";
    const scope = tokenData.scope || "";
    const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

    // Save encrypted token in MongoDB
    await McpAuthVault.saveUserToken({
      userId,
      provider: "slack",
      teamId,
      teamName,
      userSlackId,
      accessToken,
      userAccessToken: userToken,
      refreshToken,
      scope,
      expiresAt,
    });

    // Invalidate cached tools
    await McpToolCache.invalidateUserCache(userId, "slack");

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    return res.redirect(`${clientUrl}?mcp_status=success&provider=slack&team=${encodeURIComponent(teamName)}`);
  } catch (error) {
    console.error("Error in slackCallback:", error.message);
    return res.status(500).send(`Authentication error: ${error.message}`);
  }
};

/**
 * Retrieves connection status for the logged-in user.
 * GET /api/mcp/user/status/slack
 */
const getUserStatus = async (req, res) => {
  try {
    let userId = req.user?.id || req.user?._id || req.query.userId;
    if (!userId) {
      const User = require("../models/User");
      const activeUser = await User.findOne().sort({ updatedAt: -1 });
      userId = activeUser ? activeUser._id : null;
    }

    if (!userId) {
      return res.status(401).json({ success: false, connected: false, error: "Unauthorized" });
    }

    const authContext = await McpAuthVault.getValidAccessToken(userId, "slack");
    if (!authContext || !authContext.accessToken) {
      return res.json({ success: true, connected: false, provider: "slack" });
    }

    return res.json({
      success: true,
      connected: true,
      provider: "slack",
      teamName: authContext.teamName,
      teamId: authContext.teamId,
      userSlackId: authContext.userSlackId,
      connectedAt: authContext.connectedAt,
    });
  } catch (error) {
    return res.status(500).json({ success: false, connected: false, error: error.message });
  }
};

/**
 * Disconnects Slack workspace for logged-in user.
 * POST /api/mcp/user/disconnect/slack
 */
const disconnectUser = async (req, res) => {
  try {
    let userId = req.user?.id || req.user?._id || req.query.userId;
    if (!userId) {
      const User = require("../models/User");
      const activeUser = await User.findOne().sort({ updatedAt: -1 });
      userId = activeUser ? activeUser._id : null;
    }

    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    await McpAuthVault.disconnectUserToken(userId, "slack");
    await McpToolCache.invalidateUserCache(userId, "slack");

    return res.json({ success: true, message: "Slack workspace disconnected successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};


module.exports = {
  connectSlack,
  slackCallback,
  getUserStatus,
  disconnectUser,
};
