/**
 * Utility functions for Ollama model resolution, base URL normalization,
 * and SSE stream buffer decoding.
 */

const getOllamaBaseUrl = () => {
  return process.env.OLLAMA_HOST_URL
    ? process.env.OLLAMA_HOST_URL.trim().replace(/\/$/, "")
    : "http://127.0.0.1:11434";
};

/**
 * Dynamically resolves an available Ollama model from the Ollama host tags API.
 * Ensures compatibility across qwen2.5:1.5b, qwen3:4b, qwen2.5:7b, and other installed models.
 */
let cachedModelName = null;
let lastModelCheckTime = 0;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

async function getAvailableOllamaModel(customBaseUrl = null, preferredModel = null) {
  const baseUrl = customBaseUrl || getOllamaBaseUrl();
  const requested = preferredModel || process.env.OLLAMA_MODEL || "qwen2.5:1.5b";

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

        if (!resolved) {
          const priorityList = [
            "qwen2.5:7b",
            "llama3.2:3b",
            "llama3:8b",
            "mistral:7b",
            "qwen2.5:3b",
            "qwen3:4b",
            "qwen2.5:1.5b"
          ];
          for (const candidate of priorityList) {
            const match = installedModels.find(
              (m) => m === candidate || m.startsWith(`${candidate}:`)
            );
            if (match) {
              resolved = match;
              break;
            }
          }
        }

        cachedModelName = resolved || installedModels[0];
        lastModelCheckTime = now;
        return cachedModelName;
      }
    }
  } catch (err) {
    console.warn("⚠️ [OLLAMA MODEL RESOLUTION] Unable to query /api/tags:", err.message);
  }

  cachedModelName = requested;
  lastModelCheckTime = now;
  return requested;
}

async function warmOllamaConnection() {
  const baseUrl = getOllamaBaseUrl();
  const targetModel = await getAvailableOllamaModel(baseUrl, process.env.OLLAMA_MODEL);

  try {
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
        prompt: "Warmup ping"
      })
    });

    if (response.ok) {
      console.log(`✅ [OLLAMA WARMUP] Connected to Ollama model ${targetModel}`);
      return true;
    }

    const errorText = await response.text();
    console.warn(`⚠️ [OLLAMA WARMUP] Ollama responded with status ${response.status}: ${errorText}`);
  } catch (err) {
    console.warn(`⚠️ [OLLAMA WARMUP] Failed to warm Ollama connection: ${err.message}`);
  }

  return false;
}

module.exports = {
  getOllamaBaseUrl,
  getAvailableOllamaModel,
  warmOllamaConnection
};
