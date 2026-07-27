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
async function getAvailableOllamaModel(customBaseUrl = null, preferredModel = null) {
  const baseUrl = customBaseUrl || getOllamaBaseUrl();
  const requested = preferredModel || process.env.OLLAMA_MODEL || "qwen2.5:1.5b";

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    if (response.ok) {
      const data = await response.json();
      const installedModels = (data.models || []).map((m) => m.name || m.model);

      if (installedModels.length > 0) {
        // 1. Direct match or model name without tag match
        const exactMatch = installedModels.find(
          (m) => m === requested || m.startsWith(`${requested}:`)
        );
        if (exactMatch) return exactMatch;

        // 2. Priority check for standard models
        const priorityList = ["qwen2.5:1.5b", "qwen3:4b", "qwen2.5:7b"];
        for (const candidate of priorityList) {
          const match = installedModels.find(
            (m) => m === candidate || m.startsWith(`${candidate}:`)
          );
          if (match) return match;
        }

        // 3. Fallback to first available model on Ollama instance
        return installedModels[0];
      }
    }
  } catch (err) {
    console.warn("⚠️ [OLLAMA MODEL RESOLUTION] Unable to query /api/tags:", err.message);
  }

  return requested;
}

module.exports = {
  getOllamaBaseUrl,
  getAvailableOllamaModel
};
