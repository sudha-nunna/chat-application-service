const User = require("../models/User");
const ApiKey = require("../models/ApiKey");
const ApiKeyUsage = require("../models/ApiKeyUsage");
const CreditTransaction = require("../models/CreditTransaction");
const aiGateway = require("../utils/aiGateway");

/**
 * Estimate token count using word/character heuristic (fallback if tiktoken unavailable)
 */
function estimateTokens(text = "") {
  if (!text) return 0;
  if (Array.isArray(text)) {
    return text.reduce((acc, m) => acc + estimateTokens(m.content || "") + 4, 0);
  }
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/**
 * Handle OpenAI Compatible GET /api/v1/models
 */
exports.listModels = async (req, res) => {
  try {
    const models = [
      {
        id: "auto",
        object: "model",
        created: 1700000000,
        owned_by: "system",
        description: "API-only auto-routing to highest performing available node pool"
      }
    ];

    return res.json({
      object: "list",
      data: models
    });
  } catch (error) {
    return res.status(500).json({
      error: {
        message: "Failed to list available models.",
        type: "api_error",
        param: null,
        code: "internal_error"
      }
    });
  }
};

/**
 * Handle OpenAI Compatible POST /api/v1/chat/completions
 * API-only auto-routing enforced.
 */
exports.chatCompletions = async (req, res) => {
  const reqId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 7)}`;
  const createdTimestamp = Math.floor(Date.now() / 1000);

  try {
    const { messages, stream = false } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "'messages' array is required and must contain at least one message object.",
          type: "invalid_request_error",
          param: "messages",
          code: "missing_messages"
        }
      });
    }

    const userId = req.user._id || req.user.id;
    const apiKeyDoc = req.apiKey;

    // 1. Atomic Credit Reservation (Floor: 0.05 credits)
    const MINIMUM_CHARGE_FLOOR = 0.05;
    const reservedUser = await User.findOneAndUpdate(
      { _id: userId, credits: { $gte: MINIMUM_CHARGE_FLOOR } },
      { $inc: { credits: -MINIMUM_CHARGE_FLOOR } },
      { returnDocument: "after" }
    );

    if (!reservedUser) {
      return res.status(402).json({
        error: {
          message: "You have exhausted your credits balance. Please purchase additional credits to continue using the API.",
          type: "insufficient_quota",
          param: null,
          code: "insufficient_credits"
        }
      });
    }

    // Sanitize and format messages array
    const formattedMessages = messages.map(m => ({
      role: m.role || "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || "")
    }));

    const promptTokens = estimateTokens(formattedMessages);
    const userPriority = req.user.priorityScore || req.user.priority || 10;

    // 2. Handle Streaming Response (stream: true)
    if (Boolean(stream)) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      // Initial OpenAI SSE role delta chunk
      res.write(`data: ${JSON.stringify({
        id: reqId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: "auto",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      })}\n\n`);

      let fullText = "";

      const result = await aiGateway.generateStream({
        provider: "auto",
        model: "auto",
        messages: formattedMessages,
        userPriority,
        userId: userId.toString(),
        onToken: (chunkText) => {
          if (chunkText) {
            fullText += chunkText;
            res.write(`data: ${JSON.stringify({
              id: reqId,
              object: "chat.completion.chunk",
              created: createdTimestamp,
              model: "auto",
              choices: [{ index: 0, delta: { content: chunkText }, finish_reason: null }]
            })}\n\n`);
          }
        }
      });

      const finalGeneratedText = (result && result.text && result.text.trim()) ? result.text : fullText;

      // Final OpenAI stop chunk and [DONE]
      res.write(`data: ${JSON.stringify({
        id: reqId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: "auto",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

      // Async Token & Credit Accounting
      const completionTokens = estimateTokens(finalGeneratedText);
      const totalTokens = promptTokens + completionTokens;

      const modelPricing = await aiGateway.getModelPricingCached("auto");
      const promptRate = modelPricing.promptTokenCostPer1k ?? 0.05;
      const completionRate = modelPricing.completionTokenCostPer1k ?? 0.1;

      const totalCost = (promptTokens / 1000 * promptRate) + (completionTokens / 1000 * completionRate);
      const additionalDeduction = Math.max(0, totalCost - MINIMUM_CHARGE_FLOOR);

      if (additionalDeduction > 0) {
        await User.findByIdAndUpdate(userId, { $inc: { credits: -additionalDeduction } }).catch(() => {});
      }

      const todayStr = new Date().toISOString().split("T")[0];
      const finalCreditsSpent = MINIMUM_CHARGE_FLOOR + additionalDeduction;

      Promise.all([
        ApiKey.findByIdAndUpdate(apiKeyDoc._id, {
          $inc: {
            totalRequests: 1,
            totalTokensUsed: totalTokens,
            totalCreditsSpent: finalCreditsSpent
          },
          $set: { lastUsedAt: new Date() }
        }),
        ApiKeyUsage.findOneAndUpdate(
          { apiKeyId: apiKeyDoc._id, userId, date: todayStr },
          {
            $inc: {
              requestCount: 1,
              promptTokens,
              completionTokens,
              totalTokens,
              creditsDeducted: finalCreditsSpent
            }
          },
          { upsert: true }
        ),
        CreditTransaction.create({
          userId,
          amount: -finalCreditsSpent,
          type: "USAGE",
          description: `Public API Key request (${totalTokens} tokens)`
        }).catch(() => {})
      ]).catch((e) => console.error("API Key telemetry update notice:", e.message));

      return;
    }

    // 3. Handle Non-Streaming Response (stream: false)
    const result = await aiGateway.generateStream({
      provider: "auto",
      model: "auto",
      messages: formattedMessages,
      userPriority,
      userId: userId.toString()
    });

    const generatedText = (result && result.text && result.text.trim())
      ? result.text
      : "I am ready to assist you. Please resend your prompt.";

    const completionTokens = result?.completionTokens || estimateTokens(generatedText);
    const totalTokens = promptTokens + completionTokens;

    const modelPricing = await aiGateway.getModelPricingCached("auto");
    const promptRate = modelPricing.promptTokenCostPer1k ?? 0.05;
    const completionRate = modelPricing.completionTokenCostPer1k ?? 0.1;

    const totalCost = (promptTokens / 1000 * promptRate) + (completionTokens / 1000 * completionRate);
    const additionalDeduction = Math.max(0, totalCost - MINIMUM_CHARGE_FLOOR);

    if (additionalDeduction > 0) {
      await User.findByIdAndUpdate(userId, { $inc: { credits: -additionalDeduction } }).catch(() => {});
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const finalCreditsSpent = MINIMUM_CHARGE_FLOOR + additionalDeduction;

    Promise.all([
      ApiKey.findByIdAndUpdate(apiKeyDoc._id, {
        $inc: {
          totalRequests: 1,
          totalTokensUsed: totalTokens,
          totalCreditsSpent: finalCreditsSpent
        },
        $set: { lastUsedAt: new Date() }
      }),
      ApiKeyUsage.findOneAndUpdate(
        { apiKeyId: apiKeyDoc._id, userId, date: todayStr },
        {
          $inc: {
            requestCount: 1,
            promptTokens,
            completionTokens,
            totalTokens,
            creditsDeducted: finalCreditsSpent
          }
        },
        { upsert: true }
      ),
      CreditTransaction.create({
        userId,
        amount: -finalCreditsSpent,
        type: "USAGE",
        description: `Public API Key request (${totalTokens} tokens)`
      }).catch(() => {})
    ]).catch((e) => console.error("API Key telemetry update notice:", e.message));

    return res.json({
      id: reqId,
      object: "chat.completion",
      created: createdTimestamp,
      model: "auto",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: generatedText
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
      }
    });
  } catch (error) {
    console.error("Public API Controller Error:", error);
    return res.status(500).json({
      error: {
        message: "An internal server error occurred while processing the request.",
        type: "api_error",
        param: null,
        code: "internal_error"
      }
    });
  }
};
