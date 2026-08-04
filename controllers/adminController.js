const ServerNode = require("../models/ServerNode");
const { performance } = require("perf_hooks");
const { encrypt, decrypt } = require("../utils/encryption");

/**
 * Get all AI Server Nodes with live ping status test and masked secret keys
 */
exports.getAllNodes = async (req, res) => {
  try {
    const { checkClusterHealth } = require("../utils/ollamaHelper");
    // Trigger background health check asynchronously so page load is INSTANT (<10ms)
    checkClusterHealth().catch(err => console.warn("⚠️ Background health ping error:", err.message));

    const { clusterState } = require("../utils/ollamaHelper");
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

  // Scenario A: User accidentally pasted a Google Gemini API key into the URL field
  if (/^(AIzaSy|AQ\.Ab|AQ-)/i.test(trimmedUrl)) {
    secretKey = trimmedUrl;
    trimmedUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    nodeFormat = "gemini";
    if (!defaultModel || defaultModel === "llama3.2:3b") model = "gemini-1.5-flash";
  }
  // Scenario B: User accidentally pasted an OpenAI API key into the URL field
  else if (/^(sk-proj-|sk-|gsk_)/i.test(trimmedUrl)) {
    secretKey = trimmedUrl;
    trimmedUrl = "https://api.openai.com";
    nodeFormat = "openai";
    if (!defaultModel || defaultModel === "llama3.2:3b") model = "gpt-4o-mini";
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

  if (nodeFormat === "gemini" && !fullUrl.includes("googleapis.com")) {
    fullUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
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

    const finalPriority = Math.min(100, Math.max(1, Number(priority) || 10));

    const newNode = await ServerNode.create({
      name: name.trim(),
      url: cleanUrl,
      defaultModel: finalModel,
      format: nodeFormat,
      secretKey: finalSecret ? encrypt(finalSecret) : "",
      priority: finalPriority,
      isActive: isActive !== undefined ? isActive : true
    });

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
      if (validationResult.secretKey) {
        node.secretKey = encrypt(validationResult.secretKey);
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
    }

    if (secretKey !== undefined && secretKey !== "••••••••" && secretKey.trim()) {
      node.secretKey = encrypt(secretKey.trim());
    }
    if (priority !== undefined) node.priority = Math.min(100, Math.max(1, Number(priority) || 10));
    if (isActive !== undefined) node.isActive = isActive;

    await node.save();

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

    try {
      const rawSecretKey = node.secretKey ? decrypt(node.secretKey) : "";
      let targetUrl = node.url.trim().replace(/\/$/, "");
      let nodeFormat = (node.format || "openai").toLowerCase();

      // Auto-detect Gemini
      const isGeminiNode = targetUrl.includes("googleapis.com") || nodeFormat === "gemini" || (node.defaultModel && node.defaultModel.includes("gemini")) || rawSecretKey.startsWith("AQ.Ab") || rawSecretKey.startsWith("AIzaSy");

      if (isGeminiNode) {
        nodeFormat = "gemini";
        targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
        if (node.format !== "gemini" || node.url !== targetUrl) {
          node.format = "gemini";
          node.url = targetUrl;
          if (!node.defaultModel || node.defaultModel === "llama3.2:3b") {
            node.defaultModel = "gemini-1.5-flash";
          }
        }
      }

      let pingUrl;
      const headers = { "Accept": "application/json" };

      if (nodeFormat === "gemini" || targetUrl.includes("googleapis.com")) {
        const apiKey = rawSecretKey || process.env.GEMINI_API_KEY || "";
        pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
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
      isOk = pingRes.ok;
      statusText = isOk ? "HEALTHY" : `UNHEALTHY (HTTP ${pingRes.status})`;
    } catch (err) {
      isOk = false;
      statusText = `OFFLINE (${err.message})`;
    }

    const latencyMs = Number((performance.now() - tStart).toFixed(2));
    node.lastLatencyMs = latencyMs;
    node.status = statusText;
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
    return res.status(500).json({ success: false, error: "Failed to ping server node." });
  }
};
