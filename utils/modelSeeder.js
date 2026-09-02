const AIModel = require("../models/AIModel");

const DEFAULT_MODELS = [
  {
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: "gemini",
    tier: "BALANCED",
    creditCost: 2,
    contextLength: "1M",
    enabled: true,
    recommended: true,
    fallbackModels: ["gemini-2.0-flash", "zhipuai/glm-4-flash"],
    description: "Google's balanced high-speed multimodal reasoning model."
  },
  {
    modelId: "gemini-2.0-flash",
    displayName: "Gemini 2.0 Flash",
    provider: "gemini",
    tier: "FAST",
    creditCost: 1,
    contextLength: "1M",
    enabled: true,
    recommended: false,
    fallbackModels: ["qwen2.5:1.5b"],
    description: "Ultra-fast low latency Google Gemini model."
  },
  {
    modelId: "qwen2.5:1.5b",
    displayName: "Qwen 2.5 1.5B",
    provider: "ollama",
    tier: "FAST",
    creditCost: 1,
    contextLength: "32k",
    enabled: true,
    recommended: false,
    fallbackModels: ["gemini-2.0-flash"],
    description: "Lightweight, ultra-responsive edge conversational model."
  },
  {
    modelId: "zhipuai/glm-4-flash",
    displayName: "GLM-4 Flash",
    provider: "glm",
    tier: "BALANCED",
    creditCost: 2,
    contextLength: "128k",
    enabled: true,
    recommended: false,
    fallbackModels: ["gemini-2.5-flash", "meta/llama-3.1-8b-instruct"],
    description: "High-throughput multilingual enterprise reasoning model."
  },
  {
    modelId: "deepseek-v4-flash:cloud",
    displayName: "DeepSeek V4 Flash",
    provider: "ollama",
    tier: "HEAVY",
    creditCost: 5,
    contextLength: "128k",
    enabled: true,
    recommended: false,
    fallbackModels: ["kimi-k2.7-code:cloud", "gemini-2.5-flash"],
    description: "Deep reasoning and high-capacity architecture for complex tasks."
  },
  {
    modelId: "kimi-k2.7-code:cloud",
    displayName: "Kimi K2.7 Code",
    provider: "ollama",
    tier: "HEAVY",
    creditCost: 5,
    contextLength: "256k",
    enabled: true,
    recommended: false,
    fallbackModels: ["deepseek-v4-flash:cloud"],
    description: "Specialized deep-context coding and technical reasoning model."
  }
];

async function seedAIModels() {
  try {
    for (const modelDef of DEFAULT_MODELS) {
      const exists = await AIModel.findOne({ modelId: modelDef.modelId });
      if (!exists) {
        await AIModel.create(modelDef);
      }
    }
    console.log("⚡ [AI MODEL CATALOG] Verified and loaded AI Models.");
  } catch (err) {
    console.warn("⚠️ [MODEL SEEDER] Notice:", err.message);
  }
}

module.exports = seedAIModels;
