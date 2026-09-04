const AIModel = require("../models/AIModel");
const ServerNode = require("../models/ServerNode");

// Helper to format modelId into a readable Display Name
function formatDisplayName(modelId = "") {
  if (!modelId) return "Unknown Model";
  // If modelId already has custom formatting
  let clean = modelId
    .replace(/^zhipuai\//i, "")
    .replace(/^openai\//i, "")
    .replace(/:latest$/i, "");

  // Capitalize segments
  return clean
    .split(/[-_:]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Helper to deduce model tier & token pricing
function deduceTierAndPricing(modelId = "") {
  const lower = modelId.toLowerCase();
  if (lower.includes("pro") || lower.includes("opus") || lower.includes("70b") || lower.includes("72b") || lower.includes("405b") || lower.includes("coder-32b")) {
    return {
      tier: "HEAVY",
      promptTokenCostPer1k: 0.2,
      completionTokenCostPer1k: 0.4,
      minCreditCost: 1
    };
  }
  if (lower.includes("flash") || lower.includes("mini") || lower.includes("1.5b") || lower.includes("3b") || lower.includes("8b") || lower.includes("fast")) {
    return {
      tier: "FAST",
      promptTokenCostPer1k: 0.05,
      completionTokenCostPer1k: 0.1,
      minCreditCost: 0.5
    };
  }
  return {
    tier: "BALANCED",
    promptTokenCostPer1k: 0.1,
    completionTokenCostPer1k: 0.2,
    minCreditCost: 1
  };
}

/**
 * Public: Get all enabled AI Models for Chat interface
 * Single Source of Truth: Reads directly and exclusively from active ServerNodes in Admin
 */
exports.getAvailableModels = async (req, res) => {
  try {
    const activeNodes = await ServerNode.find({
      isActive: true,
      status: { $nin: ["INACTIVE", "OFFLINE"] }
    }).sort({ priority: -1, createdAt: 1 }).lean();

    // Fetch disabled model IDs from AIModel catalog to exclude them from chat availability
    const disabledDocs = await AIModel.find({ enabled: false }, { modelId: 1 }).lean();
    const disabledModelIds = new Set(disabledDocs.map((m) => (m.modelId || "").toLowerCase().trim()));

    const activeModelList = [];
    const seenModelKeys = new Set();

    activeNodes.forEach(node => {
      const serverFormat = (node.format || "openai").toLowerCase();
      const serverName = node.name || serverFormat.toUpperCase();

      // Collect all models for this active node
      const nodeModelIds = new Set();
      if (node.defaultModel && node.defaultModel.trim()) {
        nodeModelIds.add(node.defaultModel.trim());
      }
      if (Array.isArray(node.supportedModels)) {
        node.supportedModels.forEach(m => {
          if (m && typeof m === "string" && m.trim()) {
            nodeModelIds.add(m.trim());
          }
        });
      }

      // If no models were explicitly specified, provide appropriate provider default
      if (nodeModelIds.size === 0) {
        if (serverFormat === "gemini") nodeModelIds.add("gemini-2.5-flash");
        else if (serverFormat === "glm") nodeModelIds.add("zhipuai/glm-4-flash");
        else nodeModelIds.add("llama3.2:3b");
      }

      const totalModelsOnNode = nodeModelIds.size;

      nodeModelIds.forEach(mId => {
        if (disabledModelIds.has(mId.toLowerCase().trim())) {
          // Exclude models manually disabled by admin in AI Catalog
          return;
        }

        const key = `${node._id}_${mId.toLowerCase()}`;
        if (!seenModelKeys.has(key)) {
          seenModelKeys.add(key);
          const pricing = deduceTierAndPricing(mId);

          activeModelList.push({
            modelId: mId,
            displayName: formatDisplayName(mId),
            provider: serverFormat,
            serverName: serverName,
            serverId: String(node._id),
            serverFormat: serverFormat,
            modelsCount: totalModelsOnNode,
            tier: pricing.tier,
            promptTokenCostPer1k: pricing.promptTokenCostPer1k,
            completionTokenCostPer1k: pricing.completionTokenCostPer1k,
            creditCost: pricing.minCreditCost,
            minCreditCost: pricing.minCreditCost,
            enabled: true,
            recommended: mId.toLowerCase() === (node.defaultModel || "").toLowerCase(),
            isOnline: true,
            description: `Hosted on active server: ${serverName}`
          });
        }
      });
    });

    // Sort: Recommended first -> Low cost
    activeModelList.sort((a, b) => {
      if (a.recommended && !b.recommended) return -1;
      if (!a.recommended && b.recommended) return 1;
      return (a.promptTokenCostPer1k || 0.1) - (b.promptTokenCostPer1k || 0.1);
    });

    return res.json({
      success: true,
      total: activeModelList.length,
      models: activeModelList
    });
  } catch (error) {
    console.error("Error fetching available models:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch models." });
  }
};

/**
 * Admin: Get all models (including disabled ones)
 */
exports.getAllModelsAdmin = async (req, res) => {
  try {
    const activeNodes = await ServerNode.find({
      isActive: true,
      status: { $nin: ["INACTIVE", "OFFLINE"] }
    }).lean();

    const activeFormats = new Set(activeNodes.map((n) => (n.format || "openai").toLowerCase()));
    const activeModelIds = new Set();
    activeNodes.forEach((n) => {
      if (n.defaultModel && n.defaultModel.trim()) {
        activeModelIds.add(n.defaultModel.trim().toLowerCase());
      }
      if (Array.isArray(n.supportedModels)) {
        n.supportedModels.forEach((m) => {
          if (m && typeof m === "string" && m.trim()) {
            activeModelIds.add(m.trim().toLowerCase());
          }
        });
      }
    });

    const models = await AIModel.find().sort({ createdAt: -1 }).lean();

    const enrichedModels = models.map((m) => {
      const providerLower = (m.provider || "openai").toLowerCase();
      const modelIdLower = (m.modelId || "").toLowerCase();

      // Senior Developer Logic:
      // For Ollama/local nodes: must be explicitly in activeModelIds list of active Ollama nodes
      // For Cloud nodes (Gemini, OpenAI, GLM): node format must be active OR modelId explicitly supported
      let isNodeActive = false;
      if (providerLower === "ollama") {
        isNodeActive = activeModelIds.has(modelIdLower);
      } else {
        isNodeActive = activeFormats.has(providerLower) || activeModelIds.has(modelIdLower);
      }

      return {
        ...m,
        isNodeActive,
        effectiveEnabled: m.enabled !== false && isNodeActive
      };
    });

    return res.json({ success: true, models: enrichedModels });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Admin: Create / Register a new AI Model
 */
exports.createModel = async (req, res) => {
  try {
    const {
      modelId,
      displayName,
      provider,
      tier,
      creditCost,
      minCreditCost,
      promptTokenCostPer1k,
      completionTokenCostPer1k,
      maxTokenLimit,
      contextLength,
      enabled,
      recommended,
      fallbackModels,
      description
    } = req.body;

    // Strict Backend Field Validations
    if (!modelId || !modelId.trim()) {
      return res.status(400).json({ success: false, error: "Validation Error: Model ID (API String) is required." });
    }
    if (/\s/.test(modelId.trim())) {
      return res.status(400).json({ success: false, error: "Validation Error: Model ID cannot contain spaces. Use hyphens or colons (e.g. gemini-2.5-flash or qwen2.5:1.5b)." });
    }
    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ success: false, error: "Validation Error: Display Name is required." });
    }
    if (displayName.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Validation Error: Display Name must be at least 2 characters long." });
    }
    if (!provider || !provider.trim()) {
      return res.status(400).json({ success: false, error: "Validation Error: Provider Engine is required." });
    }

    const cleanModelId = modelId.trim().toLowerCase();
    const existing = await AIModel.findOne({ modelId: cleanModelId });
    if (existing) {
      return res.status(400).json({ success: false, error: `Validation Error: Model ID '${cleanModelId}' is already registered in the catalog.` });
    }

    const newModel = await AIModel.create({
      modelId: cleanModelId,
      displayName: displayName.trim(),
      provider: provider.trim().toLowerCase(),
      tier: tier ? tier.toUpperCase() : "BALANCED",
      creditCost: Math.max(0, Number(creditCost) || 1),
      minCreditCost: minCreditCost !== undefined ? Math.max(0, Number(minCreditCost)) : (Number(creditCost) || 1),
      promptTokenCostPer1k: promptTokenCostPer1k !== undefined ? Math.max(0, Number(promptTokenCostPer1k)) : 0.1,
      completionTokenCostPer1k: completionTokenCostPer1k !== undefined ? Math.max(0, Number(completionTokenCostPer1k)) : 0.2,
      maxTokenLimit: maxTokenLimit !== undefined ? Math.max(128, Number(maxTokenLimit)) : 4096,
      contextLength: contextLength || "128k",
      enabled: enabled !== undefined ? enabled : true,
      recommended: recommended !== undefined ? recommended : false,
      fallbackModels: Array.isArray(fallbackModels) ? fallbackModels : [],
      description: description ? description.trim() : ""
    });

    return res.status(201).json({ success: true, model: newModel });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Admin: Update an AI Model
 */
exports.updateModel = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    if (updateData.displayName !== undefined && (!updateData.displayName || !updateData.displayName.trim())) {
      return res.status(400).json({ success: false, error: "Validation Error: Display Name cannot be empty." });
    }
    if (updateData.modelId !== undefined && /\s/.test(updateData.modelId.trim())) {
      return res.status(400).json({ success: false, error: "Validation Error: Model ID cannot contain spaces." });
    }

    if (updateData.tier) updateData.tier = updateData.tier.toUpperCase();
    if (updateData.creditCost !== undefined) updateData.creditCost = Math.max(0, Number(updateData.creditCost));
    if (updateData.minCreditCost !== undefined) updateData.minCreditCost = Math.max(0, Number(updateData.minCreditCost));
    if (updateData.promptTokenCostPer1k !== undefined) updateData.promptTokenCostPer1k = Math.max(0, Number(updateData.promptTokenCostPer1k));
    if (updateData.completionTokenCostPer1k !== undefined) updateData.completionTokenCostPer1k = Math.max(0, Number(updateData.completionTokenCostPer1k));
    if (updateData.maxTokenLimit !== undefined) updateData.maxTokenLimit = Math.max(128, Number(updateData.maxTokenLimit));

    const updated = await AIModel.findByIdAndUpdate(id, updateData, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, error: "Model not found." });
    }

    return res.json({ success: true, model: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Admin: Delete an AI Model
 */
exports.deleteModel = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await AIModel.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Model not found." });
    }
    return res.json({ success: true, message: "Model deleted successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
