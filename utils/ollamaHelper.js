/**
 * Production-Ready AI Cluster Health Monitor, Provider Pools, 
 * Circuit Breaker Engine, and Real Health Check Service.
 */

const { performance } = require("perf_hooks");

let cachedModelName = null;
let lastModelCheckTime = 0;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

// In-memory persistent state across requests
let clusterState = [];
let healthCheckTimer = null;
let isHealthCheckExecuting = false;

/**
 * Fetches active AI server nodes strictly from MongoDB (ServerNode collection).
 */
async function refreshClusterNodesFromDB() {
  try {
    const ServerNode = require("../models/ServerNode");
    const { decrypt } = require("./encryption");
    const dbNodes = await ServerNode.find({ isActive: true }).sort({ priority: -1, priorityScore: -1, createdAt: 1 });

    if (dbNodes && dbNodes.length > 0) {
      const activeMap = new Map(clusterState.map(n => [n.id, n.activeRequests]));
      const successMap = new Map(clusterState.map(n => [n.id, n.successRequests || 0]));
      const failedMap = new Map(clusterState.map(n => [n.id, n.failedRequests || 0]));
      const consecutiveFailMap = new Map(clusterState.map(n => [n.id, n.consecutiveFailures || 0]));

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
          if (!defaultModel || defaultModel === "llama3.2:3b" || defaultModel === "gemini-1.5-flash" || defaultModel === "gemini-2.0-flash" || defaultModel === "gemini-2.5-flash") {
            defaultModel = "gemini-flash-latest";
          }
          if (n.format !== "gemini" || n.url !== nodeUrl || n.defaultModel !== defaultModel) {
            ServerNode.findByIdAndUpdate(n._id, { format: "gemini", url: nodeUrl, defaultModel }).catch(() => { });
          }
        }

        const priorityScore = typeof n.priorityScore === "number" ? n.priorityScore : (n.priority || 10);

        return {
          id: String(n._id),
          name: n.name,
          url: nodeUrl,
          secretKey: rawSecretKey,
          defaultModel,
          format: nodeFormat,
          status: n.status || "ACTIVE",
          priority: priorityScore,
          priorityScore: priorityScore,
          activeRequests: activeMap.get(String(n._id)) || 0,
          successRequests: (n.successRequests || 0) + (successMap.get(String(n._id)) || 0),
          failedRequests: (n.failedRequests || 0) + (failedMap.get(String(n._id)) || 0),
          consecutiveFailures: n.consecutiveFailures || consecutiveFailMap.get(String(n._id)) || 0,
          retryAfter: n.retryAfter || null,
          lastLatencyMs: n.latency || n.lastLatencyMs || 0,
          latency: n.latency || n.lastLatencyMs || 0,
          lastChecked: n.lastChecked || new Date(),
          lastUsedAt: n.lastUsedAt || null,
          errorMessage: n.errorMessage || ""
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

/**
 * Executes actual provider health checks every 30 seconds
 */
async function checkClusterHealth() {
  if (isHealthCheckExecuting) return;
  isHealthCheckExecuting = true;

  try {
    await refreshClusterNodesFromDB();

    console.log("\n🌐 =================== [AI CLUSTER HEALTH MONITOR] ===================");
    const ServerNode = require("../models/ServerNode");
    const now = new Date();

    for (const node of clusterState) {
      // 1. Check Rate Limit Recovery: If retryAfter expired, transition RATE_LIMITED -> CHECKING
      if (node.status === "RATE_LIMITED" && node.retryAfter && new Date(node.retryAfter) <= now) {
        node.status = "CHECKING";
        console.log(`  ├── 🔄 Node ${node.name} retryAfter period expired. Testing node recovery...`);
      }

      // Skip checking if node was manually marked INACTIVE by admin unless performing health check
      if (node.status === "INACTIVE" && node.consecutiveFailures < 5) {
        continue;
      }

      const tStart = performance.now();
      let isHealthy = false;
      let latency = 0;
      let errorMsg = "";

      try {
        let pingUrl;
        const headers = { "Accept": "application/json" };
        let fetchOptions = {
          headers,
          signal: AbortSignal.timeout(3500)
        };
        const rawSecretKey = node.secretKey || "";

        if (node.format === "gemini" || node.url.includes("googleapis.com")) {
          const apiKey = rawSecretKey || process.env.GEMINI_API_KEY || "";
          pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        } else if (node.format === "openai" || node.url.includes("openai.com")) {
          const apiKey = rawSecretKey || process.env.OPENAI_API_KEY || "";
          pingUrl = `${node.url}/v1/models`;
          if (apiKey) {
            headers["Authorization"] = `Bearer ${apiKey}`;
          }
        } else {
          pingUrl = `${node.url}/v1/models`;
          if (rawSecretKey) {
            headers["Authorization"] = `Bearer ${rawSecretKey}`;
          }
        }

        const res = await fetch(pingUrl, fetchOptions);

        latency = Number((performance.now() - tStart).toFixed(2));

        if (res.ok) {
          isHealthy = true;
          errorMsg = "";
        } else if (res.status === 429) {
          isHealthy = false;
          node.status = "RATE_LIMITED";
          node.retryAfter = new Date(Date.now() + 60 * 1000); // 60 seconds rate limit pause
          errorMsg = "HTTP 429 Provider API rate limit or quota exceeded.";
        } else {
          isHealthy = false;
          errorMsg = `HTTP ${res.status}: ${res.statusText}`;
        }
      } catch (err) {
        latency = Number((performance.now() - tStart).toFixed(2));
        isHealthy = false;
        errorMsg = err.message || "Network connection timeout";
      }

      // Update Node State & Circuit Breaker Engine
      node.latency = latency;
      node.lastLatencyMs = latency;
      node.lastChecked = new Date();

      if (isHealthy) {
        if (node.status === "RATE_LIMITED" && node.retryAfter && new Date(node.retryAfter) > new Date()) {
          // Preserve RATE_LIMITED status until cooldown period expires
        } else {
          node.status = "ACTIVE";
          node.consecutiveFailures = 0;
          node.errorMessage = "";
          node.retryAfter = null;
        }
      } else {
        if (node.status !== "RATE_LIMITED") {
          node.consecutiveFailures = (node.consecutiveFailures || 0) + 1;
          node.errorMessage = errorMsg;

          // Circuit Breaker: 5 consecutive failures transitions node to INACTIVE
          if (node.consecutiveFailures >= 5) {
            node.status = "INACTIVE";
            console.warn(`  ├── ⚡ [CIRCUIT BREAKER TRIGGERED] Node ${node.name} failed 5 consecutive health checks. Transitioned to INACTIVE.`);
          } else {
            node.status = "CHECKING";
          }
        }
      }

      // Persist telemetry to MongoDB
      if (node.id && node.id.length === 24) {
        try {
          await ServerNode.findByIdAndUpdate(node.id, {
            status: node.status,
            priorityScore: node.priorityScore,
            latency: node.latency,
            lastLatencyMs: node.lastLatencyMs,
            lastChecked: node.lastChecked,
            errorMessage: node.errorMessage,
            consecutiveFailures: node.consecutiveFailures,
            retryAfter: node.retryAfter
          });
        } catch (e) { }
      }

      const icon = node.status === "ACTIVE" ? "🟢" : (node.status === "RATE_LIMITED" ? "🟡" : "⚠️");
      console.log(`  ├── ${icon} ${node.id} (${node.name}): ${node.url}`);
      console.log(`  │   Status: ${node.status} | Priority: ${node.priorityScore} | Active Tasks: ${node.activeRequests} | Latency: ${node.latency} ms`);
    }
    console.log("========================================================================\n");
  } catch (err) {
    console.error("Health Check Error:", err.message);
  } finally {
    isHealthCheckExecuting = false;
  }
}

/**
 * Returns dynamic Provider Pools from DB nodes
 */
function getProviderPools() {
  const geminiPool = clusterState.filter(n => n.format === "gemini" || n.url.includes("googleapis.com"));
  const llamaPool = clusterState.filter(n => n.format === "ollama" || (!n.url.includes("googleapis.com") && !n.url.includes("openai.com")));
  const openAiPool = clusterState.filter(n => n.format === "openai" || n.url.includes("openai.com"));

  return {
    geminiPool,
    llamaPool,
    openAiPool,
    allNodes: clusterState
  };
}

const { selectBestClusterNodeWithPreemption } = require("./priorityDispatcher");

function selectBestClusterNode(userPriority = 10) {
  return selectBestClusterNodeWithPreemption(userPriority, clusterState);
}

const getOllamaBaseUrl = () => {
  if (clusterState.length > 0) {
    return clusterState[0].url;
  }
  return "";
};

async function getAvailableOllamaModel(customBaseUrl = null, preferredModel = null) {
  const node = selectBestClusterNode(10);
  const baseUrl = customBaseUrl || (node ? node.url : "");
  const requested = preferredModel || (node ? node.defaultModel : "llama3.2:3b");
  return requested;
}

/**
 * Server startup connection warmup (loads server nodes from DB without background continuous polling)
 */
async function warmOllamaConnection() {
  await refreshClusterNodesFromDB();
  return true;
}

module.exports = {
  getOllamaBaseUrl,
  getAvailableOllamaModel,
  warmOllamaConnection,
  clusterState,
  selectBestClusterNode,
  checkClusterHealth,
  refreshClusterNodesFromDB,
  getProviderPools
};
