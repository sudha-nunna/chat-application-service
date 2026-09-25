"use strict";

const axios = require("axios");
const TELEGRAM_TOPICS = require("../../config/telegramTopics");
const { ALERT_TYPES, SEVERITY } = require("../../config/alertTypes");
const logger = require("../../utils/logger");

// Hardcoded Non-Secret Operational Constants
const PROD_DOMAIN = "https://aibe.codegene.io";
const CHAT_ID = "-1003503757676";

// In-Memory Deduplication Cache (Key -> Timestamp)
const recentAlerts = new Map();
const DUP_WINDOW_MS = 60 * 1000; // 60 Seconds

/**
 * Checks if the current execution environment is allowed to dispatch live Telegram alerts.
 */
function isProductionEnv() {
  const isProdEnv = process.env.NODE_ENV === "production";
  const appUrl = (process.env.APP_URL || "").trim().toLowerCase();
  const isProdDomain = appUrl === PROD_DOMAIN || appUrl.includes("aibe.codegene.io");

  return isProdEnv || isProdDomain;
}

/**
 * HTML Escaper helper
 */
function escapeHtml(str) {
  if (typeof str !== "string") {
    if (str === null || str === undefined) return "";
    str = String(str);
  }
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Dispatches an alert to Telegram Supergroup Topic Thread with retries and rate-limiting safeguards.
 */
async function sendTelegramMessage(targetChatID, messageText, topicType, parseMode = "Markdown", retries = 3) {
  // Read ONLY the Bot Token from process.env.TELEGRAM_BOT_TOKEN
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !targetChatID) return;

  const threadId = TELEGRAM_TOPICS[topicType] || TELEGRAM_TOPICS[ALERT_TYPES.CRITICAL];

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: targetChatID,
      message_thread_id: threadId,
      text: messageText
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    await axios.post(url, payload);
  } catch (err) {
    const errorData = err?.response?.data;

    // ── Handle HTTP 429 (Rate Limited) Gracefully ─────────────
    if ((err?.response?.status === 429 || errorData?.error_code === 429) && retries > 0) {
      const retryAfterSec = errorData?.parameters?.retry_after || 5;
      const delayMs = (retryAfterSec * 1000) + 500;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return sendTelegramMessage(targetChatID, messageText, topicType, parseMode, retries - 1);
    }

    // ── Fallback if Entity Parsing Fails (HTTP 400) ─────────────
    if (parseMode && errorData && errorData.error_code === 400 && String(errorData.description).includes("can't parse")) {
      try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await axios.post(url, {
          chat_id: targetChatID,
          message_thread_id: threadId,
          text: messageText
        });
        return;
      } catch (fallbackErr) {
        // Silently swallow fallback error
        return;
      }
    }

    logger.error("[TELEGRAM-ALERT-ERROR]", { error: err.message, topicType });
  }
}

/**
 * Main Centralized Alert Handler
 */
async function sendAlert({
  type = ALERT_TYPES.CRITICAL,
  severity = SEVERITY.ERROR,
  title,
  message,
  meta = {}
}) {
  // 1. Environment Guard Check
  if (!isProductionEnv()) {
    logger.info(`[TELEGRAM-LOCAL-SKIP] [${type}] ${title}: ${message}`);
    return;
  }

  // 2. Deduplication Check
  const alertHash = `${type}:${title}:${message.slice(0, 100)}`;
  const lastSent = recentAlerts.get(alertHash);
  if (lastSent && Date.now() - lastSent < DUP_WINDOW_MS) {
    return;
  }
  recentAlerts.set(alertHash, Date.now());

  // 3. Format Standardized Markdown Card
  const formattedText = 
    `*${title}*\n\n` +
    `⚡ *Severity:* \`${severity}\`\n` +
    `🖥️ *Service:* \`CodeGene-Backend\`\n` +
    `🌐 *Host:* \`https://aibe.codegene.io\`\n` +
    `⏰ *Time:* \`${new Date().toISOString()}\`\n\n` +
    `*Message:*\n${message}` +
    (Object.keys(meta).length > 0 ? `\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`` : "");

  // 4. Dispatch Telegram Alert using Hardcoded CHAT_ID
  await sendTelegramMessage(CHAT_ID, formattedText, type, "Markdown");
}

module.exports = {
  sendAlert,
  escapeHtml
};
