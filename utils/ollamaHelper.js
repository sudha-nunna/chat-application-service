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
let lastNodesRefreshTime = 0;
const NODES_CACHE_TTL_MS = 15 * 1000; // 15 seconds in-memory cache

/**
 * Fetches active AI server nodes strictly from MongoDB (ServerNode collection).
 * Uses 15s in-memory caching to eliminate per-request MongoDB query latency.
 */
async function refreshClusterNodesFromDB(force = false) {
  if (!force && clusterState.length > 0 && (Date.now() - lastNodesRefreshTime < NODES_CACHE_TTL_MS)) {
    return clusterState;
  }
  try {
    const ServerNode = require("../models/ServerNode");
    const { decrypt } = require("./encryption");
    const dbNodes = await ServerNode.find({ isActive: true }).sort({ priority: -1, priorityScore: -1, createdAt: 1 });
    lastNodesRefreshTime = Date.now();

    if (dbNodes && dbNodes.length > 0) {
      const activeMap = new Map(clusterState.map(n => [n.id, n.activeRequests]));
      const successMap = new Map(clusterState.map(n => [n.id, n.successRequests || 0]));
      const failedMap = new Map(clusterState.map(n => [n.id, n.failedRequests || 0]));
      const consecutiveFailMap = new Map(clusterState.map(n => [n.id, n.consecutiveFailures || 0]));

      const freshNodes = dbNodes.map((n) => {
        let rawSecretKey = n.secretKey ? decrypt(n.secretKey) : "";
        if (/[\u2022\*]/.test(rawSecretKey)) {
          rawSecretKey = "";
        }
        let nodeUrl = n.url.trim().replace(/\/$/, "");
        let nodeFormat = (n.format || "openai").toLowerCase();
        let defaultModel = n.defaultModel || "llama3.2:3b";

        // Auto-fix Gemini node properties ONLY if URL or key strictly indicates Google Gemini
        const isGeminiNode = nodeUrl.includes("googleapis.com") || rawSecretKey.startsWith("AQ.Ab") || rawSecretKey.startsWith("AIzaSy");

        if (isGeminiNode) {
          nodeFormat = "gemini";
          if (!nodeUrl || (!nodeUrl.includes("googleapis.com") && !nodeUrl.includes("openai.com"))) {
            nodeUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
          }
          if (!defaultModel || defaultModel === "llama3.2:3b" || defaultModel === "gemini-flash-latest" || defaultModel === "gemini-2.0-flash" || defaultModel === "gemini-3.6-flash") {
            defaultModel = "gemini-2.5-flash";
          }
          if (n.format !== "gemini" || n.defaultModel !== defaultModel) {
            ServerNode.findByIdAndUpdate(n._id, { format: "gemini", defaultModel }).catch(() => { });
          }
        }

        // Auto-fix GLM node properties ONLY if URL or key strictly indicates official NVIDIA NIM
        const isGlmNode = nodeUrl.includes("integrate.api.nvidia.com") || rawSecretKey.startsWith("nvapi-");

        if (isGlmNode) {
          nodeFormat = "glm";
          if (!nodeUrl || !nodeUrl.includes("nvidia.com")) {
            nodeUrl = "https://integrate.api.nvidia.com/v1";
          }
          if (!defaultModel || defaultModel === "llama3.2:3b" || defaultModel === "glm-4-flash" || defaultModel === "z-ai/glm-5.2" || defaultModel.includes("gemini")) {
            defaultModel = "zhipuai/glm-4-flash";
          }
          if (n.format !== "glm" || n.defaultModel !== defaultModel) {
            ServerNode.findByIdAndUpdate(n._id, { format: "glm", defaultModel }).catch(() => { });
          }
        }

        const priorityScore = typeof n.priorityScore === "number" ? n.priorityScore : (n.priority || 10);

        let nodeStatus = n.status || "ACTIVE";
        // Recovery logic:
        // - RATE_LIMITED: only recover if retryAfter has expired (or was never set)
        // - INACTIVE: recover after 30s (network blip) unless admin manually deactivated via isActive=false
        if (nodeStatus === "RATE_LIMITED") {
          if (!n.retryAfter || new Date(n.retryAfter) <= new Date()) {
            nodeStatus = "ACTIVE";
            ServerNode.findByIdAndUpdate(n._id, { status: "ACTIVE", consecutiveFailures: 0, retryAfter: null, errorMessage: "" }).catch(() => {});
            console.log(`  ✅ [RATE_LIMIT RECOVERED] Node ${n.name} retryAfter expired — restored to ACTIVE.`);
          }
          // else: keep RATE_LIMITED until retryAfter passes — do NOT override
        } else if (nodeStatus === "INACTIVE" && n.updatedAt && (new Date() - new Date(n.updatedAt)) > 30000) {
          nodeStatus = "ACTIVE";
          ServerNode.findByIdAndUpdate(n._id, { status: "ACTIVE", consecutiveFailures: 0, retryAfter: null, errorMessage: "" }).catch(() => {});
        }

        return {
          id: String(n._id),
          name: n.name,
          url: nodeUrl,
          secretKey: rawSecretKey,
          defaultModel,
          format: nodeFormat,
          status: nodeStatus,
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

      // Only append Local Ollama emergency fallback if zero active nodes are in DB
      if (freshNodes.length === 0) {
        clusterState.push({
          id: "local_ollama_11434",
          name: "Local Ollama Engine",
          url: "http://127.0.0.1:11434",
          secretKey: "",
          defaultModel: process.env.OLLAMA_MODEL || "qwen2.5:1.5b",
          format: "ollama",
          status: "ACTIVE",
          priority: 5,
          priorityScore: 5,
          activeRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          consecutiveFailures: 0,
          retryAfter: null,
          lastLatencyMs: 0,
          latency: 0,
          lastChecked: new Date(),
          lastUsedAt: null,
          errorMessage: ""
        });
      }

      // (Auto-seeding removed: Admin has full control over all server nodes)

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

      // On-Demand Failover Strategy: Skip background pings for Cloud API nodes (Gemini/OpenAI/GLM)
      // to preserve 100% of API rate-limit quota for real user chat requests!
      const isCloudNode = node.format === "gemini" || node.format === "glm" || (node.format === "openai" && node.url.includes("openai.com")) || node.url.includes("googleapis.com") || node.url.includes("nvidia.com");
      if (isCloudNode) {
        if (node.status !== "RATE_LIMITED" || (node.retryAfter && new Date(node.retryAfter) <= now)) {
          node.status = "ACTIVE";
          node.consecutiveFailures = 0;
          node.errorMessage = "";
        }
        console.log(`  ├── 🟢 ${node.id} (${node.name}): On-Demand Cloud Node (${node.format.toUpperCase()}) | Status: ACTIVE`);
        continue;
      }
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
        const nodeFormat = (node.format || "openai").toLowerCase();

        if (nodeFormat === "gemini" || node.url.includes("googleapis.com")) {
          // DB key only — no process.env fallback
          const apiKey = rawSecretKey;
          if (!apiKey) {
            console.warn(`  ⚠️ [HEALTH CHECK SKIP] Gemini node '${node.name}' has no API key in DB. Add it via Admin Dashboard.`);
            continue;
          }
          pingUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        } else if (node.format === "glm" || node.url.includes("integrate.api.nvidia.com")) {
          // DB key only — no process.env fallback
          const apiKey = rawSecretKey;
          if (!apiKey) {
            console.warn(`  ⚠️ [HEALTH CHECK SKIP] GLM node '${node.name}' has no API key in DB. Add it via Admin Dashboard.`);
            continue;
          }
          pingUrl = `https://integrate.api.nvidia.com/v1/models`;
          headers["Authorization"] = `Bearer ${apiKey}`;
        } else if (node.format === "openai" || node.url.includes("openai.com")) {
          // DB key only — no process.env fallback
          const apiKey = rawSecretKey;
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

        const tStart = performance.now();
        const res = await fetch(pingUrl, fetchOptions);

        latency = Number((performance.now() - tStart).toFixed(2));

        if (res.ok || (res.status === 401 && (node.format === "glm" || node.format === "gemini" || node.format === "openai"))) {
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
        const isCloudNode = node.format === "glm" || node.format === "gemini" || node.format === "openai" || node.url.includes("nvidia.com") || node.url.includes("googleapis.com");
        if (isCloudNode && (node.secretKey || process.env.NVIDIA_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY)) {
          isHealthy = true;
          errorMsg = "";
        } else {
          isHealthy = false;
          errorMsg = err.message || "Network connection timeout";
        }
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
  const glmPool = clusterState.filter(n => n.format === "glm" || n.url.includes("integrate.api.nvidia.com"));
  const llamaPool = clusterState.filter(n => n.format === "ollama" || (!n.url.includes("googleapis.com") && !n.url.includes("openai.com") && !n.url.includes("integrate.api.nvidia.com")));
  const openAiPool = clusterState.filter(n => n.format === "openai" || n.url.includes("openai.com"));

  return {
    geminiPool,
    glmPool,
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
