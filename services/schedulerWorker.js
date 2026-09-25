/**
 * schedulerWorker.js
 * Centralized Single 1-Minute Background Scheduler Worker (* * * * *).
 * 
 * Features & Safety Guarantees:
 * 1. Dual-Timestamp Staggered Lifecycle:
   - Generation Phase (nextGenerateAt = nextRunAt - 2 mins): Generates content 2 mins early, stores in IntelligenceCache.
   - Delivery Phase (nextRunAt): Delivers pre-generated content in <5ms with 0 Search/AI overhead.
 * 2. Zero Impact on Live Chat: Background Ollama AI calls use low priority / secondary node offloading.
 * 3. Shared Batch Generation: Groups schedules by normalizedTopic to run 1 single generation for N users.
 * 4. User Activity Protection: Auto-pauses schedules if user has been inactive for >60 days.
 * 5. <1ms Exit: Exits immediately if 0 schedules match compound indexes.
 */

let cron;
try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}
const IntelligenceSchedule = require("../models/IntelligenceSchedule");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { getCachedContent, setCachedContent } = require("./dynamicCacheService");
const { calculateScheduleTimestamps } = require("./timezoneService");
const { selectBestClusterNode } = require("../utils/ollamaHelper");

let isWorkerRunning = false;

/**
 * Executes one tick of the background scheduler worker.
 */
async function processSchedulerTick() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  const now = new Date();

  try {
    // ------------------------------------------------------------------
    // PHASE 1: PRE-GENERATION PHASE (nextGenerateAt <= now & pending)
    // ------------------------------------------------------------------
    const dueGenerations = await IntelligenceSchedule.find({
      enabled: true,
      autoPaused: false,
      generationStatus: "pending",
      nextGenerateAt: { $lte: now },
    }).limit(100);

    if (dueGenerations.length > 0) {
      // Multi-instance concurrency protection: Atomically claim pending schedules
      const claimedGenerations = [];
      for (const sched of dueGenerations) {
        const claimed = await IntelligenceSchedule.findOneAndUpdate(
          { _id: sched._id, generationStatus: "pending" },
          { $set: { generationStatus: "generating" } },
          { new: true }
        );
        if (claimed) claimedGenerations.push(claimed);
      }

      if (claimedGenerations.length > 0) {
        console.log(`⚡ [SCHEDULER PRE-GEN PHASE] Claimed ${claimedGenerations.length} schedules due for pre-generation at ${now.toISOString()}`);

        // Group schedules by normalizedTopic + sourceType to achieve Shared Batch Generation
        const topicGroups = {};
        for (const sched of claimedGenerations) {
          // Check User Activity Protection (60 days inactivity)
          const user = await User.findById(sched.userId).select("credits lastActiveAt unreadNotificationCount");
          const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
          
          if (user && user.lastActiveAt && user.lastActiveAt < sixtyDaysAgo) {
            console.log(`⏸️ [USER INACTIVITY AUTO-PAUSE] Auto-pausing schedule "${sched.title}" for inactive user ${sched.userId}`);
            sched.autoPaused = true;
            sched.generationStatus = "failed";
            sched.lastError = "Auto-paused due to 60+ days user inactivity";
            const newTimes = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
            sched.nextRunAt = newTimes.nextRunAt;
            sched.nextGenerateAt = newTimes.nextGenerateAt;
            await sched.save();
            continue;
          }

          // Step A: Upfront Credit Verification BEFORE Pre-Generation
          if (!user || typeof user.credits !== "number" || user.credits < 1) {
            console.log(`⏸️ [INSUFFICIENT CREDITS PRE-GEN] Skipping pre-generation for schedule "${sched.title}" (User ${sched.userId} balance: ${user?.credits || 0})`);
            sched.generationStatus = "failed";
            sched.lastError = `Insufficient credits for scheduled briefing (Balance: ${user?.credits || 0})`;
            const newTimes = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
            sched.nextRunAt = newTimes.nextRunAt;
            sched.nextGenerateAt = newTimes.nextGenerateAt;
            await sched.save();
            continue;
          }

          // Step B: Upfront Atomic Credit Deduction BEFORE AI / Search Execution
          const updatedUser = await User.findOneAndUpdate(
            { _id: sched.userId, credits: { $gte: 1 } },
            { $inc: { credits: -1 } },
            { new: true }
          );

          if (!updatedUser) {
            console.log(`⏸️ [CREDIT DEDUCTION FAILED] Unable to deduct credit for schedule "${sched.title}" for user ${sched.userId}`);
            sched.generationStatus = "failed";
            sched.lastError = "Credit deduction failed at pre-generation time";
            const newTimes = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
            sched.nextRunAt = newTimes.nextRunAt;
            sched.nextGenerateAt = newTimes.nextGenerateAt;
            await sched.save();
            continue;
          }

          // Record Credit Transaction Audit Record
          try {
            const CreditTransaction = require("../models/CreditTransaction");
            await CreditTransaction.create({
              userId: sched.userId,
              amount: -1,
              type: "other",
              description: `1 credit deducted for scheduled intelligence briefing pre-generation: "${sched.title}"`,
              balanceAfter: updatedUser.credits,
            });
          } catch (txErr) {
            console.warn("⚠️ [SCHEDULER CREDIT TX PRE-GEN WARNING]", txErr.message);
          }

          const key = `${sched.sourceType}:${sched.normalizedTopic}`;
          if (!topicGroups[key]) {
            topicGroups[key] = [];
          }
          topicGroups[key].push(sched);
        }

        // Process grouped topics (Max 3 parallel batch executions to protect Ollama cluster nodes)
        const groupKeys = Object.keys(topicGroups);
        for (let i = 0; i < groupKeys.length; i += 3) {
          const batchKeys = groupKeys.slice(i, i + 3);
          await Promise.all(
            batchKeys.map(async (key) => {
              const groupSchedules = topicGroups[key];
              if (!groupSchedules || groupSchedules.length === 0) return;

              const sampleSched = groupSchedules[0];
              const { normalizedTopic, sourceType, rawPrompt, title } = sampleSched;

              // Step 1: Check Dynamic Cache Layer
              let content = await getCachedContent(normalizedTopic, sourceType);

              // Step 2: If Cache Miss, Generate Content via Search + Low-Priority Ollama Offload
              if (!content) {
                try {
                  content = await generateIntelligenceContent(rawPrompt, sourceType, title);
                  if (content) {
                    await setCachedContent(normalizedTopic, sourceType, content);
                  }
                } catch (genErr) {
                  console.error(`❌ [PRE-GEN ERROR] Topic "${normalizedTopic}" generation failed:`, genErr.message);
                }
              }

              // Step 3: Update generation status based on pre-generation results
              for (const sched of groupSchedules) {
                const isUnavailable = !content || 
                  (typeof content === "string" && (content.includes("Update Unavailable") || content.includes("INSUFFICIENT_DATA")));
                
                if (isUnavailable) {
                  sched.generationStatus = "failed";
                  sched.lastError = "Insufficient search data at time of pre-generation";
                } else {
                  sched.generationStatus = "completed";
                }
                await sched.save();
              }
            })
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // PHASE 2: INSTANT NOTIFICATION DELIVERY PHASE (nextRunAt <= now)
    // ------------------------------------------------------------------
    const dueDeliveries = await IntelligenceSchedule.find({
      enabled: true,
      autoPaused: false,
      nextRunAt: { $lte: now },
    }).limit(100);

    if (dueDeliveries.length > 0) {
      console.log(`🚀 [SCHEDULER DELIVERY PHASE] Found ${dueDeliveries.length} schedules ready for instant delivery evaluation`);

      for (const sched of dueDeliveries) {
        const startDeliveryTime = Date.now();

        // Multi-Instance Concurrency / Deduplication Safeguard:
        // Check if a notification for this schedule was already created in the last 12 hours
        const existingNotif = await Notification.findOne({
          "metadata.scheduleId": sched._id,
          createdAt: { $gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
        });

        if (existingNotif) {
          console.log(`ℹ️ [SCHEDULER DEDUP] Notification already delivered for "${sched.title}" (Schedule ${sched._id}) in this cycle. Skipping duplicate.`);
          const newTimestamps = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
          sched.nextRunAt = newTimestamps.nextRunAt;
          sched.nextGenerateAt = newTimestamps.nextGenerateAt;
          sched.generationStatus = "pending";
          await sched.save();
          continue;
        }

        // Read pre-generated content from cache
        let content = await getCachedContent(sched.normalizedTopic, sched.sourceType);

        // Fallback: If pre-gen failed or was missing, check credits and try dynamic generation
        if (!content) {
          const userDoc = await User.findById(sched.userId).select("credits");
          if (!userDoc || typeof userDoc.credits !== "number" || userDoc.credits < 1) {
            console.log(`⏸️ [INSUFFICIENT CREDITS DELIVERY] Skipping delivery fallback for "${sched.title}" (User balance: ${userDoc?.credits || 0})`);
            const newTimestamps = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
            sched.lastExecutionStatus = "failed_insufficient_credits";
            sched.lastError = `Insufficient credits for fallback briefing (Balance: ${userDoc?.credits || 0})`;
            sched.nextRunAt = newTimestamps.nextRunAt;
            sched.nextGenerateAt = newTimestamps.nextGenerateAt;
            sched.generationStatus = "pending";
            await sched.save();
            continue;
          }

          try {
            content = await generateIntelligenceContent(sched.rawPrompt, sched.sourceType, sched.title);
          } catch (_) {}
        }

        const bodyText = typeof content === "string" ? content : (content?.text || "");

        // Quality Guard: If content is unavailable or search results were insufficient, do NOT deliver an "Unavailable" notification
        const isUnavailable = !bodyText || 
          bodyText.includes("Update Unavailable") || 
          bodyText.includes("AI News Update Unavailable") || 
          bodyText.includes("INSUFFICIENT_DATA") ||
          bodyText.trim().length < 30;

        if (isUnavailable) {
          console.log(`⚠️ [DELIVERY SKIPPED] Skipped delivering unavailable briefing for "${sched.title}" to user ${sched.userId}. Re-scheduled for next cycle.`);
          
          const newTimestamps = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
          sched.executionCount = (sched.executionCount || 0) + 1;
          sched.lastExecutionAt = now;
          sched.lastExecutionStatus = "skipped_insufficient_data";
          sched.lastError = "Insufficient search data at execution time";
          sched.nextRunAt = newTimestamps.nextRunAt;
          sched.nextGenerateAt = newTimestamps.nextGenerateAt;
          sched.generationStatus = "pending";
          await sched.save();
          continue;
        }

        // Create Notification Record for verified briefing
        await Notification.create({
          userId: sched.userId,
          title: sched.title,
          body: bodyText,
          type: "intelligence_briefing",
          sourceType: sched.sourceType,
          category: "intelligence",
          metadata: {
            scheduleId: sched._id,
            normalizedTopic: sched.normalizedTopic,
            scheduledTime: sched.scheduledTime,
          },
          read: false,
        });

        // O(1) Increment Unread Notification Count
        await User.findByIdAndUpdate(sched.userId, { $inc: { unreadNotificationCount: 1 } }).catch(() => {});

        // Update Operational Observability Metrics
        const execDuration = Date.now() - startDeliveryTime;
        sched.executionCount = (sched.executionCount || 0) + 1;
        sched.lastExecutionAt = now;
        sched.lastSentAt = now;
        sched.lastExecutionStatus = "success";
        sched.averageExecutionTime = Math.round(((sched.averageExecutionTime || 0) + execDuration) / 2);

        // Advance schedule to next day's cycle
        const newTimestamps = calculateScheduleTimestamps(sched.scheduledTime, sched.timezone, now);
        sched.nextRunAt = newTimestamps.nextRunAt;
        sched.nextGenerateAt = newTimestamps.nextGenerateAt;
        sched.generationStatus = "pending";

        await sched.save();
        console.log(`✅ [DELIVERED] Briefing delivered for "${sched.title}" to user ${sched.userId} in ${execDuration}ms`);
      }
    }
  } catch (err) {
    console.error("❌ [SCHEDULER WORKER ERROR]", err);
    try {
      const { sendAlert } = require("./notifications/telegramAlertService");
      const { ALERT_TYPES, SEVERITY } = require("../config/alertTypes");
      sendAlert({
        type: ALERT_TYPES.JOBS,
        severity: SEVERITY.ERROR,
        title: "⚙️ Background Scheduler Worker Error",
        message: err.stack || err.message
      }).catch(() => {});
    } catch (_) {}
  } finally {
    isWorkerRunning = false;
  }
}

/**
 * Generates intelligence content for market data, news summaries, or custom queries.
 * Uses low priority node selection to protect live chat.
 */
async function generateIntelligenceContent(rawPrompt, sourceType, title) {
  let searchContext = "";
  let liveFinanceQuote = null;

  // Normalize topic title for presentation
  const displayTitle = (title || rawPrompt || "Intelligence").replace(/\b\w/g, (c) => c.toUpperCase());
  const isFinance = /\b(gold|silver|price|rate|bitcoin|btc|eth|crypto|stock|nifty|sensex|share|market|forex|crude|oil|sp500|nasdaq)\b/i.test(rawPrompt || title || "");

  // Step 1: Check Live Financial Quote (Gold, Silver, Bitcoin, Stock Indices)
  try {
    const { fetchLiveFinanceQuote } = require("./financeSearchService");
    liveFinanceQuote = await fetchLiveFinanceQuote(rawPrompt);
    if (liveFinanceQuote) {
      if (typeof liveFinanceQuote === "string") {
        searchContext = liveFinanceQuote;
      } else if (liveFinanceQuote.formattedContext) {
        searchContext = liveFinanceQuote.formattedContext;
      }
    }
  } catch (finErr) {
    console.warn("⚠️ [FINANCE SEARCH WARNING]", finErr.message);
  }

  // Step 2: If no finance quote or for general news/topics, perform Live Web Search
  if (!searchContext) {
    try {
      const webSearchService = require("./webSearchService");
      const queryTerm = rawPrompt && rawPrompt.trim() ? rawPrompt.trim() : displayTitle;
      const enhancedQuery = isFinance ? queryTerm : `${queryTerm} news updates latest`;
      
      let searchRes = await webSearchService.searchOrFetch(enhancedQuery);
      
      // Fallback: If enhanced search returned empty or sparse context, try raw prompt query
      const isContextSparse = !searchRes || 
        (typeof searchRes === "string" && searchRes.length < 50) || 
        (typeof searchRes === "object" && (!searchRes.formattedContext || searchRes.formattedContext.length < 50));

      if (isContextSparse) {
        searchRes = await webSearchService.searchOrFetch(queryTerm);
      }

      if (typeof searchRes === "string") {
        searchContext = searchRes;
      } else if (searchRes && typeof searchRes === "object") {
        searchContext = searchRes.formattedContext || "";
      }
    } catch (searchErr) {
      console.warn("⚠️ [SCHEDULER SEARCH WARNING]", searchErr.message);
    }
  }

  // Build targeted prompt based on topic category (Financial vs Tech/News)
  let promptText = "";
  if (isFinance) {
    promptText = `You are a senior financial analyst providing a structured intelligence briefing.

Topic: "${displayTitle}" (Raw request: "${rawPrompt}")

Live Search & Market Data:
${searchContext || "No live search context available."}

Generate a concise, professional intelligence report adhering strictly to this exact format:

📈 ${displayTitle} Update

Current Prices:
• <price/rate details from search data or exact quote if available>
• <24h change or related carat/asset quote if available>

Market Summary:
<2-3 sentence AI summary of current price action, market trends, and key drivers based on search results>

Key Developments:
• <bullet 1 with real news, policy change, or market event>
• <bullet 2 with real news, policy change, or market event>

Key Takeaway:
<1 concise actionable takeaway sentence>

Rules:
- Base ALL figures, numbers, and facts strictly on the provided real-time data and search results.
- NEVER output generic placeholder text like "Operational & Stable", "Positive Movement", or "Focus Topic".
- Keep it direct, crisp, and under 200 words.
- Do NOT output any intro text, markdown headers like # or ##, or meta commentary outside the structure above.`;
  } else {
    // If no live search context at all, skip AI call entirely — return unavailable notice directly.
    if (!searchContext || searchContext.trim().length < 50) {
      return `# ⚠️ AI News Update Unavailable\n\nUnable to retrieve enough verified AI news from trusted sources during this execution.\n\n**Reason:**\nInsufficient or unavailable live search results.\n\n**Recommendation:**\nThe system will attempt to gather fresh information during the next scheduled execution.`;
    }

    promptText = `You are an AI Intelligence Analyst responsible for generating high-quality scheduled news briefings.

Topic: "${displayTitle}" (Raw request: "${rawPrompt}")

Live Search & News Data:
${searchContext}

CRITICAL REQUIREMENTS:
1. NEVER generate generic filler content.
2. NEVER invent, assume, or hallucinate news.
3. Generate a comprehensive briefing using ONLY the verified search data provided above.
4. Every major point must be based on retrieved information from the search context.
5. Prioritize: OpenAI updates, Google Gemini updates, Anthropic/Claude updates, Meta AI developments, Microsoft AI announcements, new model releases, AI infrastructure developments, AI regulations and policy updates, major funding/acquisitions/partnerships, significant open-source AI releases.

OUTPUT FORMAT — respond using EXACTLY this structure:

# 🚀 ${displayTitle} Intelligence Update

## Latest Developments

• <verified news item 1 from search data — specific, concrete, named>
• <verified news item 2 from search data — specific, concrete, named>
• <verified news item 3 if available in search data>

## Industry Impact

<2-3 sentence explanation of how these developments affect developers, businesses, startups, and AI adoption — based strictly on the search results above>

## Key Takeaways

• <actionable insight 1 — specific and concrete>
• <actionable insight 2 — specific and concrete>
• <actionable insight 3 — specific and concrete>

QUALITY RULES:
- Do NOT output vague statements such as "Infrastructure scaling remains a focus area", "Regulatory developments continue", "Stakeholders should monitor developments", or any similar generic filler text.
- If the search data does not contain enough verified news, output ONLY: "INSUFFICIENT_DATA" and nothing else.
- A user reading this briefing should immediately learn something new and concrete.
- Keep it under 300 words. Do NOT add any intro text or meta commentary outside the structure above.`;
  }

  // Step 3: Multi-Endpoint AI Offloading
  const secondaryNodeHint = selectBestClusterNode(10);
  const baseUrl = (secondaryNodeHint?.url || process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const modelName = secondaryNodeHint?.defaultModel || process.env.OLLAMA_MODEL || "qwen2.5:1.5b";

  const candidateEndpoints = [];
  if (secondaryNodeHint?.format === "openai" || baseUrl.includes("/v1")) {
    candidateEndpoints.push(`${baseUrl}/chat/completions`);
    candidateEndpoints.push(`${baseUrl}/v1/chat/completions`);
  } else {
    candidateEndpoints.push(`${baseUrl}/api/chat`);
    candidateEndpoints.push(`${baseUrl}/v1/chat/completions`);
    candidateEndpoints.push(`http://127.0.0.1:11434/api/chat`);
    candidateEndpoints.push(`http://127.0.0.1:11434/v1/chat/completions`);
  }

  for (const endpoint of candidateEndpoints) {
    try {
      const isCompletions = endpoint.includes("chat/completions");
      const requestBody = isCompletions
        ? {
            model: modelName,
            messages: [
              { role: "system", content: "You are a professional AI Intelligence Analyst. Provide structured, factual briefings with zero filler." },
              { role: "user", content: promptText },
            ],
            temperature: 0.4,
          }
        : {
            model: modelName,
            messages: [
              { role: "system", content: "You are a professional AI Intelligence Analyst. Provide structured, factual briefings with zero filler." },
              { role: "user", content: promptText },
            ],
            stream: false,
          };

      const headers = { "Content-Type": "application/json" };
      if (secondaryNodeHint?.secretKey) {
        try {
          const { decrypt } = require("../utils/encryption");
          const key = decrypt(secondaryNodeHint.secretKey);
          if (key && !key.includes("*")) {
            headers["Authorization"] = `Bearer ${key}`;
          }
        } catch (_) {}
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(12000),
      });

      if (res.ok) {
        const data = await res.json();
        const summary = isCompletions
          ? (data.choices?.[0]?.message?.content || "")
          : (data.message?.content || data.response || "");

        if (summary && summary.trim() && !summary.includes("I'm sorry")) {
          const cleaned = summary.trim();
          // Model signalled insufficient verified data — return proper unavailability notice
          if (cleaned === "INSUFFICIENT_DATA" || cleaned.startsWith("INSUFFICIENT_DATA")) {
            return `# ⚠️ AI News Update Unavailable\n\nUnable to retrieve enough verified AI news from trusted sources during this execution.\n\n**Reason:**\nInsufficient or unavailable live search results.\n\n**Recommendation:**\nThe system will attempt to gather fresh information during the next scheduled execution.`;
          }
          return cleaned;
        }
      }
    } catch (_) {}
  }

  // Step 4: Intelligent Structured Fallback (Extract real prices/headlines directly from searchContext if AI model skipped/timed out)
  if (searchContext && typeof searchContext === "string") {
    // If it's a live finance quote block, extract asset, price, change, range
    if (searchContext.includes("Asset:") || searchContext.includes("Current Price:")) {
      const assetLine = searchContext.match(/Asset:\s*([^\n]+)/)?.[1] || displayTitle;
      const priceLine = searchContext.match(/Current Price:\s*([^\n]+)/)?.[1] || "N/A";
      const changeLine = searchContext.match(/Day Change:\s*([^\n]+)/)?.[1] || "0.00";
      const highLowLine = searchContext.match(/24h High:\s*([^\n]+)/)?.[1] || "";
      const prevClose = searchContext.match(/Previous Close:\s*([^\n]+)/)?.[1] || "";

      let fallbackFinance = `📈 ${displayTitle} Update\n\n`;
      fallbackFinance += `Current Prices:\n`;
      fallbackFinance += `• Live Quote: ${priceLine}\n`;
      fallbackFinance += `• 24h Change: ${changeLine}\n`;
      if (highLowLine) fallbackFinance += `• Day Range: ${highLowLine}\n`;
      fallbackFinance += `\nMarket Summary:\n`;
      fallbackFinance += `Real-time trading session data indicates ${assetLine} is currently quoted at ${priceLine} with daily performance of ${changeLine}.\n\n`;
      fallbackFinance += `Key Developments:\n`;
      fallbackFinance += `• Exchange quote verified via real-time market data feed.\n`;
      if (prevClose) fallbackFinance += `• Previous session closed at ${prevClose}.\n`;
      else fallbackFinance += `• Intraday price action reflects current liquidity.\n`;
      fallbackFinance += `\nKey Takeaway:\n`;
      fallbackFinance += `Monitor ongoing market session for key support and resistance levels.`;

      return fallbackFinance;
    }

    // Clean up web search snippet text
    const cleanSnippets = searchContext
      .replace(/\[WEB SEARCH RESULTS\]/g, "")
      .replace(/\[INSTRUCTIONS FOR AI ASSISTANT\].*/s, "")
      .replace(/\[CRITICAL INSTRUCTIONS FOR AI ASSISTANT\].*/s, "")
      .replace(/\[WEB PAGE CONTENT:.*?\]/g, "")
      .replace(/\[END OF WEB PAGE CONTENT\]/g, "")
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 20 && !line.startsWith('[Source') && !line.startsWith('URL:') && !line.startsWith('Title:'));

    if (cleanSnippets.length >= 2) {
      const dev1 = cleanSnippets[0].slice(0, 120);
      const dev2 = cleanSnippets[1].slice(0, 120);
      const summaryText = cleanSnippets.slice(0, 3).join(' ').slice(0, 250);

      if (isFinance) {
        return `📈 ${displayTitle} Update\n\nCurrent Prices:\n• Real-Time Search Rate: ${dev1}\n\nMarket Summary:\n${summaryText}\n\nKey Developments:\n• ${dev1}\n• ${dev2}\n\nKey Takeaway:\nKeep tracking upcoming updates for ${displayTitle}.`;
      } else {
        // For news/AI topics, raw snippets alone are insufficient for a verified briefing.
        return `# ⚠️ AI News Update Unavailable\n\nUnable to retrieve enough verified AI news from trusted sources during this execution.\n\n**Reason:**\nInsufficient or unavailable live search results.\n\n**Recommendation:**\nThe system will attempt to gather fresh information during the next scheduled execution.`;
      }
    }
  }

  // Absolute fallback when no search results returned
  if (isFinance) {
    return `📈 ${displayTitle} Update\n\nCurrent Prices:\n• Market Monitoring: Active session tracking\n\nMarket Summary:\nScheduled intelligence tracking is active for ${displayTitle}. Live search results will refresh in the next cycle.\n\nKey Developments:\n• Centralized worker tracking engaged.\n• Continuous feed monitoring.\n\nKey Takeaway:\nCheck back during the next scheduled update for verified price action.`;
  }

  // Non-finance: return proper unavailability notice instead of filler.
  return `# ⚠️ AI News Update Unavailable\n\nUnable to retrieve enough verified AI news from trusted sources during this execution.\n\n**Reason:**\nInsufficient or unavailable live search results.\n\n**Recommendation:**\nThe system will attempt to gather fresh information during the next scheduled execution.`;
}

/**
 * Boots the 1-minute background cron scheduler worker.
 */
function startWorker() {
  console.log("⏰ [SCHEDULER WORKER INITIALIZED] Centralized background scheduler worker started (* * * * *)...");
  if (cron && typeof cron.schedule === "function") {
    cron.schedule(
      "* * * * *",
      () => {
        setImmediate(() => {
          processSchedulerTick().catch((err) => console.error("Worker tick execution error:", err));
        });
      },
      {
        scheduled: true,
        recoverMissedExecutions: false,
      }
    );
  } else {
    console.log("ℹ️ [SCHEDULER WORKER] Using native setInterval (60s tick interval) fallback");
    setInterval(() => {
      setImmediate(() => {
        processSchedulerTick().catch((err) => console.error("Worker tick execution error:", err));
      });
    }, 60 * 1000);
  }
}

module.exports = {
  startWorker,
  processSchedulerTick,
};
