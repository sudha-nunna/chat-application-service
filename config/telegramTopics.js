"use strict";

const { ALERT_TYPES } = require("./alertTypes");

/**
 * Topic IDs for CodeGene Production Alerts Telegram Supergroup (-1003503757676)
 * Secrets stay in .env, Topic Thread IDs are maintained in code config.
 */
const TELEGRAM_TOPICS = Object.freeze({
  [ALERT_TYPES.CRITICAL]:   5,   // 🚨 Critical System Alerts
  [ALERT_TYPES.AI]:         6,   // 🤖 AI & LLM Errors
  [ALERT_TYPES.MCP]:        7,   // 🔌 MCP & External Integrations
  [ALERT_TYPES.JOBS]:       8,   // ⚙️ Background Jobs & Queues
  [ALERT_TYPES.ADMIN]:      9,   // 👨‍💼 Admin & Business Operations
  [ALERT_TYPES.DEPLOYMENT]: 10,  // 🚀 Deployments & System Health

  // Legacy fallback mappings
  err:     5,
  cg:      10,
  user:    9,
  cron:    8,
  ferr:    5,
  support: 9
});

module.exports = TELEGRAM_TOPICS;
