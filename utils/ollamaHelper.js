/**
 * Distributed Ollama Cluster Node Resolution, Smart Load Balancer,
 * Failover Execution, and Live Health Diagnostics System.
 */

const { performance } = require("perf_hooks");

let cachedModelName = null;
let lastModelCheckTime = 0;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Returns array of configured cluster nodes with active state tracking
 */
function getClusterNodes() {
  return [];
}

// In-memory persistent state across requests
let clusterState = [];

/**
 * Fetches active AI server nodes strictly from MongoDB (ServerNode collection).
 */
async function refreshClusterNodesFromDB() {
  try {
    const ServerNode = require("../models/ServerNode");
    const { decrypt } = require("./encryption");
    const dbNodes = await ServerNode.find({ isActive: true }).sort({ priority: -1, createdAt: 1 });

    if (dbNodes && dbNodes.length > 0) {
      const activeMap = new Map(clusterState.map(n => [n.id, n.activeRequests]));

      const freshNodes = dbNodes.map((n) => {
        const rawSecretKey = n.secretKey ? decrypt(n.secretKey) : "";
        let nodeUrl = n.url.trim().replace(/\/$/, "");
        let nodeFormat = (n.format || "openai").toLowerCase();
        let defaultModel = n.defaultModel || "llama3.2:3b";

        // Auto-fix Gemini node properties if URL or model or key indicates Google Gemini
        const isGeminiNode = nodeUrl.includes("googleapis.com") || nodeFormat === "gemini" || defaultModel.includes("gemini") || rawSecretKey.startsWith("AQ.Ab") || rawSecretKey.startsWith("AIzaSy");

        if (isGeminiNode) {
          nodeFormat = "gemini";
          nodeUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
          if (!defaultModel || defaultModel === "llama3.2:3b" || defaultModel === "gemini-1.5-flash") {
            defaultModel = "gemini-2.5-flash";
          }
          // Self-heal MongoDB record if it was saved with ollama format or old model by mistake
          if (n.format !== "gemini" || n.url !== nodeUrl || n.defaultModel !== defaultModel) {
            ServerNode.findByIdAndUpdate(n._id, { format: "gemini", url: nodeUrl, defaultModel }).catch(() => { });
          }
        }

        return {
          id: String(n._id),
          name: n.name,
          url: nodeUrl,
          secretKey: rawSecretKey,
          defaultModel,
          format: nodeFormat,
          status: n.status || "UNTESTED",
          activeRequests: activeMap.get(String(n._id)) || 0,
          lastLatencyMs: n.lastLatencyMs || 0
        };
      });

      clusterState.length = 0;
      freshNodes.forEach(fn => clusterState.push(fn));
      return clusterState;
    } else {
      clusterState.length = 0;
    }
  } catch (err) {
    console.warn("⚠️ [OLLAMA HELPER] Error loading server nodes from DB:", err.message);
  }
  return clusterState;
}

const getOllamaBaseUrl = () => {
  if (clusterState.length > 0) {
    return clusterState[0].url;
  }
  return "";
};

/**
 * Checks health of all cluster nodes with AbortSignal timeout and syncs status to DB
 */
async function checkClusterHealth() {
  await refreshClusterNodesFromDB();

  console.log("\n🌐 =================== [AI CLUSTER HEALTH MONITOR] ===================");

  const ServerNode = require("../models/ServerNode");

  for (const node of clusterState) {
    const tStart = performance.now();
    try {
      let pingUrl;
      const headers = { "Accept": "application/json" };
      const rawSecretKey = node.secretKey || "";

      if (node.format === "gemini" || node.url.includes("googleapis.com")) {
        const apiKey = rawSecretKey || process.env.GEMINI_API_KEY || "";
        pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      } else if (node.format === "openai" || node.url.includes("trycloudflare.com") || node.url.includes("openai.com")) {
        pingUrl = `${node.url}/v1/models`;
        if (rawSecretKey) {
          headers["Authorization"] = `Bearer ${rawSecretKey}`;
          headers["X-Internal-Secret"] = rawSecretKey;
        }
      } else {
        pingUrl = `${node.url}/api/tags`;
        if (rawSecretKey) {
          headers["Authorization"] = `Bearer ${rawSecretKey}`;
          headers["X-Internal-Secret"] = rawSecretKey;
        }
      }

      const res = await fetch(pingUrl, {
        headers,
        signal: AbortSignal.timeout(3500)
      });
      node.lastLatencyMs = Number((performance.now() - tStart).toFixed(2));
      node.status = res.ok ? "HEALTHY" : `UNHEALTHY (HTTP ${res.status})`;
    } catch (err) {
      node.lastLatencyMs = Number((performance.now() - tStart).toFixed(2));
      node.status = `OFFLINE (${err.message})`;
    }

    // Persist live status and latency back to MongoDB if it's a DB node
    if (node.id && node.id.length === 24) {
      try {
        await ServerNode.findByIdAndUpdate(node.id, {
          status: node.status,
          lastLatencyMs: node.lastLatencyMs
        });
      } catch (e) { }
    }

    const icon = node.status.startsWith("HEALTHY") ? "🟢" : "⚠️";
    console.log(`  ├── ${icon} ${node.id} (${node.name}): ${node.url}`);
    console.log(`  │   Status: ${node.status} | Active Tasks: ${node.activeRequests} | Latency: ${node.lastLatencyMs} ms`);
  }
  console.log("========================================================================\n");
}

const { selectBestClusterNodeWithPreemption } = require("./priorityDispatcher");

/**
 * Smart Load Balancer: Selects the healthiest, least-busy node.
 * Integrates In-Flight Priority Preemption (Free < Pro < Enterprise).
 */
function selectBestClusterNode(userPriority = 10) {
  return selectBestClusterNodeWithPreemption(userPriority, clusterState);
}

/**
 * Model resolution helper
 */
async function getAvailableOllamaModel(customBaseUrl = null, preferredModel = null) {
  const node = selectBestClusterNode(10);
  const baseUrl = customBaseUrl || node.url;
  const requested = preferredModel || node.defaultModel;

  const now = Date.now();
  if (cachedModelName && (now - lastModelCheckTime) < MODEL_CACHE_TTL_MS) {
    return cachedModelName;
  }

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    if (response.ok) {
      const data = await response.json();
      const installedModels = (data.models || []).map((m) => m.name || m.model);

      if (installedModels.length > 0) {
        let resolved = installedModels.find(
          (m) => m === requested || m.startsWith(`${requested}:`)
        );
        cachedModelName = resolved || installedModels[0];
        lastModelCheckTime = now;
        return cachedModelName;
      }
    }
  } catch (err) { }

  cachedModelName = requested;
  lastModelCheckTime = now;
  return requested;
}

/**
 * Server startup connection warmup
 */
async function warmOllamaConnection() {
  await checkClusterHealth();
  return true;
}

module.exports = {
  getOllamaBaseUrl,
  getAvailableOllamaModel,
  warmOllamaConnection,
  clusterState,
  selectBestClusterNode,
  checkClusterHealth,
  refreshClusterNodesFromDB
};
