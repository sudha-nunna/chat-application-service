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
  const node1Url = process.env.OLLAMA_HOST_URL
    ? process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "")
    : "https://antibody-java-unfortunately-cad.trycloudflare.com";

  const node2Url = process.env.OLLAMA_NODE_2
    ? process.env.OLLAMA_NODE_2.trim().replace(/\/$/, "")
    : "https://protecting-andale-june-butterfly.trycloudflare.com";

  return [
    {
      id: "Node-1",
      name: "Primary Cluster Node",
      url: node1Url,
      defaultModel: process.env.OLLAMA_MODEL || "qwen2.5:1.5b",
      format: "ollama", // /api/chat
      status: "HEALTHY",
      activeRequests: 0,
      lastLatencyMs: 0
    },
    {
      id: "Node-2",
      name: "Secondary Cluster Node",
      url: node2Url,
      defaultModel: process.env.OLLAMA_NODE_2_MODEL || "ggml-org/gemma-3-4b-it-qat-GGUF",
      format: "openai", // /v1/chat/completions
      status: "HEALTHY",
      activeRequests: 0,
      lastLatencyMs: 0
    }
  ];
}

// In-memory persistent state across requests
const clusterState = getClusterNodes();

const getOllamaBaseUrl = () => {
  if (process.env.OLLAMA_HOST_URL) {
    return process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "");
  }
  return clusterState[0].url;
};

/**
 * Checks health of all cluster nodes and dynamically updates URLs/models from process.env
 */
async function checkClusterHealth() {
  // Sync node URLs and default models from process.env dynamically
  if (process.env.OLLAMA_HOST_URL) {
    clusterState[0].url = process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "");
  }
  if (process.env.OLLAMA_MODEL) {
    clusterState[0].defaultModel = process.env.OLLAMA_MODEL.trim();
  }

  if (process.env.OLLAMA_NODE_2) {
    clusterState[1].url = process.env.OLLAMA_NODE_2.trim().replace(/\/$/, "");
  }
  if (process.env.OLLAMA_NODE_2_MODEL) {
    clusterState[1].defaultModel = process.env.OLLAMA_NODE_2_MODEL.trim();
  }

  console.log("\n🌐 =================== [OLLAMA CLUSTER HEALTH MONITOR] ===================");

  for (const node of clusterState) {
    const tStart = performance.now();
    try {
      if (node.format === "ollama") {
        const res = await fetch(`${node.url}/api/tags`, { headers: { "Accept": "application/json" } });
        node.lastLatencyMs = Number((performance.now() - tStart).toFixed(2));
        node.status = res.ok ? "HEALTHY" : `UNHEALTHY (HTTP ${res.status})`;
      } else {
        const res = await fetch(`${node.url}/v1/models`, { headers: { "Accept": "application/json" } });
        node.lastLatencyMs = Number((performance.now() - tStart).toFixed(2));
        node.status = res.ok ? "HEALTHY" : `UNHEALTHY (HTTP ${res.status})`;
      }
    } catch (err) {
      node.lastLatencyMs = Number((performance.now() - tStart).toFixed(2));
      node.status = `OFFLINE (${err.message})`;
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
  checkClusterHealth
};
