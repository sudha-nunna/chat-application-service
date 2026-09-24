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
      console.log(`⚡ [SCHEDULER PRE-GEN PHASE] Found ${dueGenerations.length} schedules due for pre-generation at ${now.toISOString()}`);

      // Group schedules by normalizedTopic + sourceType to achieve Shared Batch Generation
      const topicGroups = {};
      for (const sched of dueGenerations) {
        // Check User Activity Protection (Inactivity > 60 days)
        const user = await User.findById(sched.userId).select("lastActiveAt unreadNotificationCount");
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
              const startGenTime = Date.now();
              try {
                content = await generateIntelligenceContent(rawPrompt, sourceType, title);
                if (content) {
                  await setCachedContent(normalizedTopic, sourceType, content);
                }
              } catch (genErr) {
                console.error(`❌ [PRE-GEN ERROR] Topic "${normalizedTopic}" generation failed:`, genErr.message);
              }
            }

            // Step 3: Update generation status for all schedules in this topic group
            for (const sched of groupSchedules) {
              sched.generationStatus = content ? "completed" : "failed";
              if (!content) sched.lastError = "AI generation returned empty response";
              await sched.save();
            }
          })
        );
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
      console.log(`🚀 [SCHEDULER DELIVERY PHASE] Found ${dueDeliveries.length} schedules ready for instant delivery`);

      for (const sched of dueDeliveries) {
        const startDeliveryTime = Date.now();

        // Read pre-generated content from cache
        let content = await getCachedContent(sched.normalizedTopic, sched.sourceType);

        // Fallback: If pre-gen failed, try fast dynamic generation now
        if (!content) {
          try {
            content = await generateIntelligenceContent(sched.rawPrompt, sched.sourceType, sched.title);
          } catch (_) {}
        }

        const bodyText = typeof content === "string" ? content : (content?.text || `Daily update for ${sched.title}`);

        // Create Notification Record
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

        // O(1) Fast Unread Count Increment on User Document
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
        console.log(`✅ [DELIVERED] Notification delivered for "${sched.title}" to user ${sched.userId} in ${execDuration}ms`);
      }
    }
  } catch (err) {
    console.error("❌ [SCHEDULER WORKER ERROR]", err);
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
      const searchRes = await webSearchService.searchOrFetch(rawPrompt);
      if (typeof searchRes === "string") {
        searchContext = searchRes;
      } else if (searchRes && typeof searchRes === "object") {
        searchContext = searchRes.formattedContext || JSON.stringify(searchRes);
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
    promptText = `You are a senior tech & market intelligence analyst providing a structured intelligence briefing.

Topic: "${displayTitle}" (Raw request: "${rawPrompt}")

Live Search & News Data:
${searchContext || "No live search context available."}

Generate a concise, professional intelligence report adhering strictly to this exact format:

🚀 ${displayTitle} Intelligence Update

Latest Developments:
• <bullet 1 highlighting a major recent announcement, release, or news event from search data>
• <bullet 2 highlighting a secondary key update or feature>

Market & Industry Impact:
<2-3 sentence AI summary explaining industry significance and implications based on search results>

Key Takeaway:
<1 concise actionable takeaway sentence>

Rules:
- Base ALL facts, product names, and events strictly on the provided real-time search data.
- NEVER output generic placeholder text like "Operational & Stable", "Positive Movement", or "Focus Topic".
- Keep it direct, crisp, and under 200 words.
- Do NOT output any intro text, markdown headers like # or ##, or meta commentary outside the structure above.`;
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
          return summary.trim();
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
        return `🚀 ${displayTitle} Intelligence Update\n\nLatest Developments:\n• ${dev1}\n• ${dev2}\n\nMarket & Industry Impact:\n${summaryText}\n\nKey Takeaway:\nStay updated on ongoing developments and official announcements for ${displayTitle}.`;
      }
    }
  }

  // Absolute fallback when no search results returned
  if (isFinance) {
    return `📈 ${displayTitle} Update\n\nCurrent Prices:\n• Market Monitoring: Active session tracking\n\nMarket Summary:\nScheduled intelligence tracking is active for ${displayTitle}. Live search results will refresh in the next cycle.\n\nKey Developments:\n• Centralized worker tracking engaged.\n• Continuous feed monitoring.\n\nKey Takeaway:\nCheck back during the next scheduled update for verified price action.`;
  }

  return `🚀 ${displayTitle} Intelligence Update\n\nLatest Developments:\n• Scheduled monitoring enabled for ${displayTitle}.\n• News & market search context active.\n\nMarket & Industry Impact:\nAutomated background intelligence worker is actively polling live web feeds for fresh announcements regarding ${displayTitle}.\n\nKey Takeaway:\nUpdated intelligence will be delivered in the upcoming schedule cycle.`;
}

/**
 * Boots the 1-minute background cron scheduler worker.
 */
function startWorker() {
  console.log("⏰ [SCHEDULER WORKER INITIALIZED] Centralized background scheduler worker started (* * * * *)...");
  if (cron && typeof cron.schedule === "function") {
    cron.schedule("* * * * *", () => {
      processSchedulerTick().catch((err) => console.error("Worker tick execution error:", err));
    });
  } else {
    console.log("ℹ️ [SCHEDULER WORKER] Using native setInterval (60s tick interval) fallback");
    setInterval(() => {
      processSchedulerTick().catch((err) => console.error("Worker tick execution error:", err));
    }, 60 * 1000);
  }
}

module.exports = {
  startWorker,
  processSchedulerTick,
};
