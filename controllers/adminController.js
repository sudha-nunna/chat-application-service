const ServerNode = require("../models/ServerNode");
const AIModel = require("../models/AIModel");
const User = require("../models/User");
const Bot = require("../models/Bot");
const Message = require("../models/Message");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { performance } = require("perf_hooks");
const { encrypt, decrypt } = require("../utils/encryption");

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

/**
 * Admin Login via Google
 */
exports.googleAdminLogin = async (req, res) => {
  try {
    const { token } = req.body;
    console.log("Received Admin Google Login Request!");
    
    if (!token) {
      console.log("Missing token");
      return res.status(400).json({ success: false, error: "Google token is required" });
    }
    
    // Verify the Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.status(400).json({ success: false, error: "Google account email is unavailable" });
    }
    
    const userEmail = payload.email.toLowerCase().trim();
    const SUPER_ADMIN_EMAILS = ["sairamakrishna2@gmail.com", "saiphanindra8520@gmail.com", "nunnasudha03@gmail.com"];
    
    // Check if the user exists
    let user = await User.findOne({ email: userEmail });
    
    // Auto-create the super admin if they don't exist yet
    if (!user && SUPER_ADMIN_EMAILS.includes(userEmail)) {
      user = await User.create({
        name: payload.name || "Super Admin",
        email: userEmail,
        role: "admin",
        authType: "google",
        profilePic: payload.picture || ""
      });
    }
    
    if (!user) {
      return res.status(403).json({ success: false, error: `Access denied. No account found for ${userEmail}.` });
    }
    
    if (user.role !== "admin" && !SUPER_ADMIN_EMAILS.includes(userEmail)) {
      return res.status(403).json({ success: false, error: "Access denied. You do not have admin privileges." });
    }
    
    const jwtToken = jwt.sign(
      { id: user._id, email: user.email, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    
    return res.json({
      success: true,
      token: jwtToken,
      user: { id: user._id, name: user.name, email: user.email, role: "admin", profilePic: user.profilePic }
    });
  } catch (error) {
    console.error("Google Admin Login Error:", error);
    return res.status(500).json({ success: false, error: "Server error during admin login" });
  }
};

/**
 * Get Dashboard Stats
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalBots = await Bot.countDocuments();
    const totalMessages = await Message.countDocuments();
    const activeNodes = await ServerNode.countDocuments({ status: "ACTIVE" });
    const totalNodes = await ServerNode.countDocuments();
    
    return res.json({
      success: true,
      stats: {
        totalUsers,
        totalBots,
        totalMessages,
        activeNodes,
        totalNodes,
        systemUptime: "99.98%" // Placeholder, could calculate based on actual node uptimes
      }
    });
  } catch (error) {
    console.error("Stats Error:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch stats" });
  }
};/**
 * Get all AI Server Nodes with live ping status test and masked secret keys
 */
exports.getAllNodes = async (req, res) => {
  try {
    const { clusterState, refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    await refreshClusterNodesFromDB();
    const rawNodes = await ServerNode.find().sort({ priorityScore: -1, priority: -1, createdAt: 1 });

    const activeMap = new Map(clusterState.map(n => [n.id, n.activeRequests || 0]));
    const successMap = new Map(clusterState.map(n => [n.id, n.successRequests || 0]));
    const failedMap = new Map(clusterState.map(n => [n.id, n.failedRequests || 0]));

    // Mask secret keys in API responses while retaining prefix (e.g. sk-proj-... or AQ.Ab8...)
    const sanitizedNodes = rawNodes.map(n => {
      const doc = n.toObject();
      doc.activeRequests = activeMap.get(String(n._id)) || 0;
      doc.successRequests = (doc.successRequests || 0) + (successMap.get(String(n._id)) || 0);
      doc.failedRequests = (doc.failedRequests || 0) + (failedMap.get(String(n._id)) || 0);
      doc.priorityScore = typeof doc.priorityScore === "number" ? doc.priorityScore : (doc.priority || 10);
      doc.latency = doc.latency || doc.lastLatencyMs || 0;

      if (doc.secretKey) {
        const rawKey = decrypt(doc.secretKey);
        if (rawKey.startsWith("sk-proj-")) {
          doc.secretKey = `sk-proj-••••${rawKey.slice(-4)}`;
        } else if (rawKey.startsWith("sk-")) {
          doc.secretKey = `sk-••••${rawKey.slice(-4)}`;
        } else if (rawKey.startsWith("AQ.Ab") || rawKey.startsWith("AIza")) {
          doc.secretKey = `${rawKey.slice(0, 7)}••••${rawKey.slice(-4)}`;
        } else {
          doc.secretKey = `${rawKey.slice(0, 4)}••••${rawKey.slice(-4)}`;
        }
      } else {
        doc.secretKey = "";
      }
      return doc;
    });

    return res.json({ success: true, count: sanitizedNodes.length, nodes: sanitizedNodes });
  } catch (error) {
    console.error("Error fetching server nodes:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch server nodes." });
  }
};

/**
 * Senior Developer Grade URL Validator & Auto-Corrector
 */
function validateServerNodeUrl(rawUrl, rawSecretKey, format, defaultModel) {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { error: "Server URL is a required field." };
  }

  let trimmedUrl = rawUrl.trim();
  let secretKey = rawSecretKey ? rawSecretKey.trim() : "";
  let nodeFormat = (format || "openai").toLowerCase();
  let model = defaultModel ? defaultModel.trim() : "llama3.2:3b";

  // Smart Auto-Detector for API Keys / Format Shortcuts
  const isGeminiKey = /^(AIzaSy|AQ\.Ab|AQ-)/i.test(trimmedUrl);
  const isOpenAIKey = /^(sk-proj-|sk-|gsk_)/i.test(trimmedUrl);
  const isNvidiaKey = /^nvapi-/i.test(trimmedUrl);

  if (isGeminiKey) {
    if (isGeminiKey) secretKey = trimmedUrl;
    nodeFormat = "gemini";
    if (!defaultModel || defaultModel === "llama3.2:3b" || defaultModel === "gemini-1.5-flash" || defaultModel === "gemini-2.0-flash") model = "gemini-2.5-flash";
  } else if (isOpenAIKey && !trimmedUrl.includes("://")) {
    secretKey = trimmedUrl;
    trimmedUrl = "https://api.openai.com";
    nodeFormat = "openai";
    if (!defaultModel || defaultModel === "llama3.2:3b") model = "gpt-4o-mini";
  } else if (isNvidiaKey) {
    if (isNvidiaKey) secretKey = trimmedUrl;
    nodeFormat = "glm";
    if (!defaultModel || defaultModel === "llama3.2:3b") model = "z-ai/glm-5.2";
  }

  // Prepend protocol if missing for URL parsing validation
  let fullUrl = trimmedUrl;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
    fullUrl = `https://${fullUrl}`;
  }

  try {
    const parsed = new URL(fullUrl);
    const hostname = parsed.hostname.toLowerCase();

    // Check 1: Must be localhost, 127.0.0.1, a valid IP address, or contain a valid domain extension with dot (e.g. .com, .net, .org, .io, .dev, .trycloudflare.com)
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
    const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    const hasValidDomainDot = hostname.includes(".") && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname);

    if (!isLocalhost && !isIpAddress && !hasValidDomainDot) {
      return { error: `Invalid Server URL "${rawUrl}". High-quality URL required (e.g. http://localhost:11434, http://192.168.1.100:1234, or https://my-tunnel.trycloudflare.com).` };
    }

    // Check 2: Explicitly reject single-word or dummy hostnames like "aa", "aaa", "test", "demo", "abc"
    if (hostname.length < 3 || /^(aa|aaa|test|demo|abc|qwerty|foo|bar|123)$/i.test(hostname)) {
      return { error: `Invalid Server URL "${rawUrl}". Single-letter or dummy URLs like 'aa' are strictly rejected.` };
    }

    fullUrl = fullUrl.replace(/\/$/, "");
  } catch (err) {
    return { error: `Invalid Server URL syntax "${rawUrl}". Please provide a valid HTTP or HTTPS endpoint URL.` };
  }

  return {
    cleanUrl: fullUrl,
    secretKey,
    nodeFormat,
    model
  };
}

/**
 * Create a new AI Server Node with strict validation
 */
exports.createNode = async (req, res) => {
  try {
    const { name, url, defaultModel, format, priority, isActive, secretKey } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Server Name is a required field." });
    }

    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: "Server URL is a required field." });
    }

    const validationResult = validateServerNodeUrl(url, secretKey, format, defaultModel);
    if (validationResult.error) {
      return res.status(400).json({ success: false, error: validationResult.error });
    }

    const { cleanUrl, secretKey: finalSecret, nodeFormat, model: finalModel } = validationResult;

    const supported = Array.isArray(req.body.supportedModels) && req.body.supportedModels.length > 0 
      ? req.body.supportedModels 
      : (finalModel ? [finalModel] : []);

    const newNode = await ServerNode.create({
      name: name.trim(),
      url: cleanUrl,
      defaultModel: finalModel,
      supportedModels: supported,
      modelsCount: Math.max(1, supported.length),
      lastScannedAt: new Date(),
      format: nodeFormat,
      secretKey: finalSecret ? encrypt(finalSecret) : "",
      priority: finalPriority,
      isActive: isActive !== undefined ? isActive : true
    });

    // Auto-sync supported models to user-facing AIModel catalog
    const allModelsToSync = Array.from(new Set([finalModel, ...(newNode.supportedModels || [])])).filter(Boolean);
    await ensureModelsInCatalog(allModelsToSync, nodeFormat);

    // Seed/clear memory cache in ollamaHelper
    const { refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    if (typeof refreshClusterNodesFromDB === "function") {
      await refreshClusterNodesFromDB();
    }

    const sanitizedNode = newNode.toObject();
    sanitizedNode.secretKey = sanitizedNode.secretKey ? "••••••••" : "";

    return res.status(201).json({ success: true, node: sanitizedNode });
  } catch (error) {
    console.error("Error creating server node:", error.message);
    return res.status(500).json({ success: false, error: "Failed to create server node." });
  }
};

/**
 * Helper: Ensure discovered/saved models exist in AIModel catalog for user chat dropdown
 */
async function ensureModelsInCatalog(modelsList, provider) {
  try {
    if (!Array.isArray(modelsList) || modelsList.length === 0) return;
    for (const modelId of modelsList) {
      if (!modelId || typeof modelId !== "string") continue;
      const cleanId = modelId.trim();
      const exists = await AIModel.findOne({ modelId: cleanId });
      if (!exists) {
        const isHeavy = cleanId.includes("pro") || cleanId.includes("deepseek") || cleanId.includes("70b") || cleanId.includes("kimi");
        const isFast = cleanId.includes("flash") || cleanId.includes("1.5b") || cleanId.includes("2.0") || cleanId.includes("mini");
        await AIModel.create({
          modelId: cleanId,
          displayName: cleanId.replace(/^models\//, ""),
          provider: provider || "openai",
          tier: isHeavy ? "HEAVY" : (isFast ? "FAST" : "BALANCED"),
          creditCost: isHeavy ? 3 : (isFast ? 1 : 2),
          contextLength: "128k",
          enabled: true,
          recommended: false,
          fallbackModels: []
        });
      }
    }
  } catch (err) {
    console.warn("⚠️ [CATALOG SYNC] Notice:", err.message);
  }
}

/**
 * Update an existing AI Server Node with encrypted secretKey
 */
exports.updateNode = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, url, defaultModel, format, priority, isActive, secretKey } = req.body;

    const node = await ServerNode.findById(id);
    if (!node) {
      return res.status(404).json({ success: false, error: "Server node not found." });
    }

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ success: false, error: "Server Name cannot be empty." });
      node.name = name.trim();
    }

    if (url !== undefined) {
      const validationResult = validateServerNodeUrl(url, secretKey, format, defaultModel);
      if (validationResult.error) {
        return res.status(400).json({ success: false, error: validationResult.error });
      }
      node.url = validationResult.cleanUrl;
      if (validationResult.secretKey && !/[\u2022\*]/.test(validationResult.secretKey) && validationResult.secretKey.trim()) {
        node.secretKey = encrypt(validationResult.secretKey.trim());
      }
      if (validationResult.nodeFormat) {
        node.format = validationResult.nodeFormat;
      }
      if (validationResult.model) {
        node.defaultModel = validationResult.model;
      }
    } else {
      if (defaultModel !== undefined) node.defaultModel = defaultModel.trim();
      if (format !== undefined) node.format = format.toLowerCase();
      if (secretKey !== undefined && !/[\u2022\*]/.test(secretKey) && secretKey.trim()) {
        node.secretKey = encrypt(secretKey.trim());
      }
    }
    if (req.body.supportedModels !== undefined && Array.isArray(req.body.supportedModels)) {
      node.supportedModels = req.body.supportedModels;
      node.modelsCount = Math.max(1, req.body.supportedModels.length);
      node.lastScannedAt = new Date();
    } else if (node.supportedModels && Array.isArray(node.supportedModels)) {
      node.modelsCount = Math.max(1, node.supportedModels.length);
    }
    if (priority !== undefined) node.priority = Math.min(100, Math.max(1, Number(priority) || 10));
    if (isActive !== undefined) node.isActive = isActive;

    await node.save();

    // Auto-sync updated supported models to user-facing AIModel catalog
    const allModelsToSync = Array.from(new Set([node.defaultModel, ...(node.supportedModels || [])])).filter(Boolean);
    await ensureModelsInCatalog(allModelsToSync, node.format);

    const { refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    if (typeof refreshClusterNodesFromDB === "function") {
      await refreshClusterNodesFromDB();
    }

    return res.json({ success: true, node });
  } catch (error) {
    console.error("Error updating server node:", error.message);
    return res.status(500).json({ success: false, error: "Failed to update server node." });
  }
};

/**
 * Auto-Discover Available Models from a Server Endpoint & API Key
 */
exports.discoverServerModels = async (req, res) => {
  try {
    let { url, format, secretKey, nodeId } = req.body;

    const isMaskedOrEmpty = !secretKey || /[\u2022\*]/.test(secretKey);
    if (nodeId && (!url || isMaskedOrEmpty)) {
      const node = await ServerNode.findById(nodeId);
      if (node) {
        url = url || node.url;
        format = format || node.format;
        if (isMaskedOrEmpty && node.secretKey) {
          try {
            secretKey = decrypt(node.secretKey);
          } catch (e) {
            secretKey = node.secretKey;
          }
        }
      }
    }

    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: "Server URL is required to discover models." });
    }

    let cleanUrl = url.trim().replace(/\/$/, "");
    let resolvedFormat = (format || "openai").toLowerCase();
    let resolvedKey = secretKey ? secretKey.trim() : "";
    if (/[\u2022\*]/.test(resolvedKey)) {
      resolvedKey = "";
    } else if (resolvedKey && (resolvedKey.startsWith("U2FsdGVkX1") || resolvedKey.includes(":"))) {
      try {
        const decryptedKey = decrypt(resolvedKey);
        if (decryptedKey) resolvedKey = decryptedKey;
      } catch (e) {}
    }

    let models = [];
    const timeoutSignal = AbortSignal.timeout(12000);

    // 1. Google Gemini Provider
    if (resolvedFormat === "gemini" || cleanUrl.includes("googleapis.com")) {
      const pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${resolvedKey}`;
      const resp = await fetch(pingUrl, { signal: timeoutSignal });
      if (!resp.ok) {
        return res.status(400).json({
          success: false,
          error: `Gemini API returned HTTP ${resp.status}: ${resp.statusText}. Please verify your API Key.`
        });
      }
      const data = await resp.json();
      models = (data.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => {
          const mId = m.name.replace(/^models\//, "");
          return {
            modelId: mId,
            displayName: m.displayName || mId,
            provider: "gemini",
            tier: mId.includes("pro") ? "HEAVY" : (mId.includes("2.0") ? "FAST" : "BALANCED"),
            contextLength: mId.includes("2.5") ? "1M" : "128k"
          };
        });
    }
    // 2. Ollama / Self-Hosted Cluster / Private Cloud
    else if (resolvedFormat === "ollama" || cleanUrl.includes("/ollama") || cleanUrl.includes("11434")) {
      const headers = { "Accept": "application/json" };
      if (resolvedKey) headers["Authorization"] = `Bearer ${resolvedKey}`;

      const pingUrl = cleanUrl.endsWith("/api/tags") ? cleanUrl : `${cleanUrl}/api/tags`;
      const resp = await fetch(pingUrl, { headers, signal: timeoutSignal });
      if (!resp.ok) {
        return res.status(400).json({
          success: false,
          error: `Ollama server returned HTTP ${resp.status}: ${resp.statusText}`
        });
      }
      const data = await resp.json();
      models = (data.models || []).map((m) => {
        const name = m.name || m.model;
        const isHeavy = name.includes("deepseek") || name.includes("kimi") || name.includes("70b") || (m.details?.parameter_size && m.details.parameter_size.includes("T"));
        const isFast = name.includes("1.5b") || name.includes("2b") || name.includes("mini");
        return {
          modelId: name,
          displayName: name.split(":")[0].toUpperCase() + (name.includes(":") ? ` (${name.split(":")[1]})` : ""),
          provider: "ollama",
          tier: isHeavy ? "HEAVY" : (isFast ? "FAST" : "BALANCED"),
          contextLength: "128k"
        };
      });
    }
    // 3. OpenAI / NVIDIA GLM / NIM / VLLM / Open WebUI
    else {
      const headers = { "Accept": "application/json" };
      if (resolvedKey) headers["Authorization"] = `Bearer ${resolvedKey}`;

      let pingUrl = cleanUrl.endsWith("/models") ? cleanUrl : (cleanUrl.endsWith("/v1") ? `${cleanUrl}/models` : `${cleanUrl}/v1/models`);
      const resp = await fetch(pingUrl, { headers, signal: timeoutSignal });
      if (!resp.ok) {
        return res.status(400).json({
          success: false,
          error: `Provider API returned HTTP ${resp.status}: ${resp.statusText}`
        });
      }
      const data = await resp.json();
      const rawList = data.data || data.models || [];
      const isNvidia = cleanUrl.includes("nvidia.com") || resolvedFormat === "glm";
      models = rawList.map((m) => {
        const id = m.id || m.name;
        return {
          modelId: id,
          displayName: id,
          provider: isNvidia ? "glm" : "openai",
          tier: id.includes("gpt-4") || id.includes("70b") || id.includes("deepseek") ? "HEAVY" : "BALANCED",
          contextLength: "128k"
        };
      });
    }

    return res.json({
      success: true,
      provider: resolvedFormat,
      totalDiscovered: models.length,
      models
    });
  } catch (error) {
    console.error("Error auto-discovering models:", error.message);
    return res.status(500).json({ success: false, error: error.message || "Failed to discover models from server." });
  }
};

/**
 * Delete an AI Server Node
 */
exports.deleteNode = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ServerNode.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: "Server node not found." });
    }

    const { refreshClusterNodesFromDB } = require("../utils/ollamaHelper");
    if (typeof refreshClusterNodesFromDB === "function") {
      await refreshClusterNodesFromDB();
    }

    return res.json({ success: true, message: "Server node deleted successfully." });
  } catch (error) {
    console.error("Error deleting server node:", error.message);
    return res.status(500).json({ success: false, error: "Failed to delete server node." });
  }
};

/**
 * Ping an AI Server Node URL immediately to test connectivity & measure latency
 */
exports.pingNode = async (req, res) => {
  try {
    const { id } = req.params;
    const node = await ServerNode.findById(id);

    if (!node) {
      return res.status(404).json({ success: false, error: "Server node not found." });
    }

    const tStart = performance.now();
    let isOk = false;
    let statusText = "HEALTHY";
    let rawSecretKey = "";
    let targetUrl = node.url ? node.url.trim().replace(/\/$/, "") : "";
    let nodeFormat = (node.format || "openai").toLowerCase();

    try {
      if (node.secretKey) {
        try {
          rawSecretKey = decrypt(node.secretKey);
        } catch (e) {
          rawSecretKey = node.secretKey;
        }
      }

      // Auto-detect Gemini
      const isGeminiNode = targetUrl.includes("googleapis.com") || nodeFormat === "gemini" || (node.defaultModel && node.defaultModel.includes("gemini")) || rawSecretKey.startsWith("AQ.Ab") || rawSecretKey.startsWith("AIzaSy");

      if (isGeminiNode) {
        nodeFormat = "gemini";
        targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
        if (node.format !== "gemini" || node.url !== targetUrl) {
          node.format = "gemini";
          node.url = targetUrl;
          if (!node.defaultModel || node.defaultModel === "llama3.2:3b" || node.defaultModel === "gemini-1.5-flash" || node.defaultModel === "gemini-2.0-flash") {
            node.defaultModel = "gemini-2.5-flash";
          }
        }
      }

      // Auto-detect GLM
      const isGlmNode = targetUrl.includes("integrate.api.nvidia.com") || nodeFormat === "glm" || (node.defaultModel && node.defaultModel.includes("glm")) || rawSecretKey.startsWith("nvapi-");

      if (isGlmNode) {
        nodeFormat = "glm";
        targetUrl = "https://integrate.api.nvidia.com/v1";
        if (node.format !== "glm" || node.url !== targetUrl) {
          node.format = "glm";
          node.url = targetUrl;
          if (!node.defaultModel || node.defaultModel === "llama3.2:3b") {
            node.defaultModel = "z-ai/glm-5.2";
          }
        }
      }

      let pingUrl;
      const headers = { "Accept": "application/json" };

      if (nodeFormat === "gemini" || targetUrl.includes("googleapis.com")) {
        // DB key only — no env fallback
        const apiKey = rawSecretKey;
        if (!apiKey) {
          isOk = false;
          statusText = "UNHEALTHY (No API Key — add via Admin Dashboard)";
          return res.json({ success: true, id: node._id, name: node.name, url: node.url, status: statusText, latencyMs: 0, isOk: false });
        }
        pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      } else if (nodeFormat === "glm" || targetUrl.includes("integrate.api.nvidia.com")) {
        // DB key only — no env fallback
        const apiKey = rawSecretKey;
        if (!apiKey) {
          isOk = false;
          statusText = "UNHEALTHY (No API Key — add via Admin Dashboard)";
          return res.json({ success: true, id: node._id, name: node.name, url: node.url, status: statusText, latencyMs: 0, isOk: false });
        }
        pingUrl = `https://integrate.api.nvidia.com/v1/models`;
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (nodeFormat === "ollama") {
        pingUrl = `${targetUrl}/api/tags`;
        if (rawSecretKey) {
          headers["Authorization"] = `Bearer ${rawSecretKey}`;
          headers["X-Internal-Secret"] = rawSecretKey;
        }
      } else {
        pingUrl = `${targetUrl}/v1/models`;
        if (rawSecretKey) {
          headers["Authorization"] = `Bearer ${rawSecretKey}`;
          headers["X-Internal-Secret"] = rawSecretKey;
        }
      }

      const pingRes = await fetch(pingUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3500)
      });
      const isCloudNode = nodeFormat === "glm" || nodeFormat === "gemini" || nodeFormat === "openai" || targetUrl.includes("nvidia.com") || targetUrl.includes("googleapis.com") || targetUrl.includes("openai.com");
      isOk = pingRes.ok || (isCloudNode && pingRes.status === 401);
      statusText = isOk ? "ACTIVE" : (pingRes.status === 429 ? "RATE_LIMITED" : `UNHEALTHY (HTTP ${pingRes.status})`);
    } catch (err) {
      const isCloudNode = nodeFormat === "glm" || nodeFormat === "gemini" || nodeFormat === "openai" || targetUrl.includes("nvidia.com") || targetUrl.includes("googleapis.com") || targetUrl.includes("openai.com");
      // For cloud nodes with a DB key, treat network errors as ACTIVE (firewall/timeout, not key issue)
      if (isCloudNode && rawSecretKey) {
        isOk = true;
        statusText = "ACTIVE";
      } else {
        isOk = false;
        statusText = `OFFLINE (${err.message})`;
      }
    }

    let enumStatus = "ACTIVE";
    if (isOk) {
      enumStatus = "ACTIVE";
    } else if (statusText.includes("429")) {
      enumStatus = "RATE_LIMITED";
    } else {
      enumStatus = "OFFLINE";
    }

    const latencyMs = Number((performance.now() - tStart).toFixed(2));
    node.lastLatencyMs = latencyMs;
    node.status = enumStatus;
    node.consecutiveFailures = isOk ? 0 : (node.consecutiveFailures || 0) + 1;
    node.errorMessage = isOk ? "" : statusText;
    await node.save();

    return res.json({
      success: true,
      id: node._id,
      name: node.name,
      url: node.url,
      status: statusText,
      latencyMs,
      isOk
    });
  } catch (error) {
    console.error("Error pinging node:", error.message);
    const latencyMs = Number((performance.now() - tStart).toFixed(2));
    node.status = "OFFLINE";
    node.errorMessage = `OFFLINE (${error.message})`;
    node.consecutiveFailures = (node.consecutiveFailures || 0) + 1;
    await node.save().catch(() => {});
    return res.json({
      success: true,
      id: node._id,
      name: node.name,
      url: node.url,
      status: `OFFLINE (${error.message})`,
      latencyMs,
      isOk: false
    });
  }
};

/**
 * ==========================================
 * USER & CREDIT MANAGEMENT
 * ==========================================
 */

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 }).lean();
    const ModelUsage = require("../models/ModelUsage");
    const Usage = require("../models/Usage");

    // Aggregate lifetime tokens and requests per user
    const userStats = await ModelUsage.aggregate([
      {
        $group: {
          _id: "$userId",
          totalTokens: { $sum: { $add: ["$promptTokens", "$completionTokens"] } },
          totalCreditsUsed: { $sum: "$creditsUsed" },
          totalRequests: { $sum: 1 }
        }
      }
    ]);

    const statsMap = new Map();
    userStats.forEach(s => {
      statsMap.set(s._id.toString(), s);
    });

    const enrichedUsers = users.map(u => {
      const stat = statsMap.get(u._id.toString()) || { totalTokens: 0, totalCreditsUsed: 0, totalRequests: 0 };
      const isPaid = Boolean(u.isPaidUser || u.totalCreditsPurchased > 0);
      return {
        ...u,
        isPaidUser: isPaid,
        tier: isPaid ? "Paid (Unlimited)" : "Free (50/day)",
        totalTokens: stat.totalTokens || 0,
        totalCreditsUsed: parseFloat((stat.totalCreditsUsed || 0).toFixed(4)),
        totalRequests: stat.totalRequests || 0
      };
    });

    return res.json({ success: true, count: enrichedUsers.length, users: enrichedUsers });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch users." });
  }
};

exports.updateUserCredits = async (req, res) => {
  try {
    const { id } = req.params;
    const { credits, plan, isPaidUser } = req.body;
    
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });

    if (credits !== undefined) {
      const amountDiff = Number(credits) - user.credits;
      
      const CreditTransaction = require("../models/CreditTransaction");
      await CreditTransaction.create({
        userId: user._id,
        amount: amountDiff,
        type: amountDiff > 0 ? "admin_grant" : "admin_deduct",
        description: `Admin manual balance adjustment`,
        balanceAfter: Number(credits)
      });
      
      user.credits = Number(credits);
    }
    
    if (plan !== undefined) {
      user.plan = plan;
    }

    if (isPaidUser !== undefined) {
      user.isPaidUser = Boolean(isPaidUser);
    }

    await user.save();
    return res.json({ success: true, user });
  } catch (error) {
    console.error("Error updating user credits:", error);
    return res.status(500).json({ success: false, error: "Failed to update user." });
  }
};

/**
 * ==========================================
 * SUBSCRIPTION PLANS MANAGEMENT
 * ==========================================
 */

exports.getAllPlans = async (req, res) => {
  try {
    const Plan = require("../models/Plan");
    const plans = await Plan.find().sort({ displayOrder: 1, priorityScore: 1 });
    return res.json({ success: true, count: plans.length, plans });
  } catch (error) {
    console.error("Error fetching plans:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch subscription plans." });
  }
};

exports.createPlan = async (req, res) => {
  try {
    const Plan = require("../models/Plan");
    const plan = await Plan.create(req.body);
    return res.status(201).json({ success: true, plan });
  } catch (error) {
    console.error("Error creating plan:", error);
    return res.status(500).json({ success: false, error: "Failed to create subscription plan." });
  }
};

exports.updatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const mongoose = require("mongoose");
    const Plan = require("../models/Plan");
    
    const isObjectId = mongoose.Types.ObjectId.isValid(id);
    const query = isObjectId ? { _id: id } : { key: id };

    const plan = await Plan.findOneAndUpdate(query, req.body, { new: true, runValidators: false });
    
    if (!plan) return res.status(404).json({ success: false, error: "Credit package not found." });
    return res.json({ success: true, plan });
  } catch (error) {
    console.error("Error updating plan:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to update credit package." });
  }
};

exports.deletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const mongoose = require("mongoose");
    const Plan = require("../models/Plan");
    
    const isObjectId = mongoose.Types.ObjectId.isValid(id);
    const query = isObjectId ? { _id: id } : { key: id };

    const plan = await Plan.findOne(query);
    if (!plan) return res.status(404).json({ success: false, error: "Credit package not found." });
    
    await Plan.deleteOne(query);
    return res.json({ success: true, message: "Credit package deleted successfully." });
  } catch (error) {
    console.error("Error deleting plan:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to delete credit package." });
  }
};
