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
    const activeNodes = await ServerNode.find({ isActive: true }).sort({ priority: -1, createdAt: 1 }).lean();

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
    const models = await AIModel.find().sort({ createdAt: -1 }).lean();
    return res.json({ success: true, models });
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

    if (!modelId || !displayName || !provider) {
      return res.status(400).json({ success: false, error: "modelId, displayName, and provider are required." });
    }

    const existing = await AIModel.findOne({ modelId: modelId.trim() });
    if (existing) {
      return res.status(400).json({ success: false, error: `Model ID '${modelId}' already exists in catalog.` });
    }

    const newModel = await AIModel.create({
      modelId: modelId.trim(),
      displayName: displayName.trim(),
      provider: provider.toLowerCase(),
      tier: tier ? tier.toUpperCase() : "BALANCED",
      creditCost: Number(creditCost) || 1,
      minCreditCost: minCreditCost !== undefined ? Math.max(0, Number(minCreditCost)) : (Number(creditCost) || 1),
      promptTokenCostPer1k: promptTokenCostPer1k !== undefined ? Math.max(0, Number(promptTokenCostPer1k)) : 0.1,
      completionTokenCostPer1k: completionTokenCostPer1k !== undefined ? Math.max(0, Number(completionTokenCostPer1k)) : 0.2,
      maxTokenLimit: maxTokenLimit !== undefined ? Number(maxTokenLimit) : 4096,
      contextLength: contextLength || "128k",
      enabled: enabled !== undefined ? enabled : true,
      recommended: recommended !== undefined ? recommended : false,
      fallbackModels: Array.isArray(fallbackModels) ? fallbackModels : [],
      description: description || ""
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

    if (updateData.tier) updateData.tier = updateData.tier.toUpperCase();
    if (updateData.creditCost !== undefined) updateData.creditCost = Math.max(0, Number(updateData.creditCost));
    if (updateData.minCreditCost !== undefined) updateData.minCreditCost = Math.max(0, Number(updateData.minCreditCost));
    if (updateData.promptTokenCostPer1k !== undefined) updateData.promptTokenCostPer1k = Math.max(0, Number(updateData.promptTokenCostPer1k));
    if (updateData.completionTokenCostPer1k !== undefined) updateData.completionTokenCostPer1k = Math.max(0, Number(updateData.completionTokenCostPer1k));
    if (updateData.maxTokenLimit !== undefined) updateData.maxTokenLimit = Math.max(0, Number(updateData.maxTokenLimit));

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
