"use strict";

/**
 * Standardized Alert Types for CodeGene Production Alerts
 */
const ALERT_TYPES = Object.freeze({
  CRITICAL:   "CRITICAL",   // System crash, DB down, HTTP 500 spike
  AI:         "AI",         // Ollama timeout, tool engine failure, voice/avatar render error
  MCP:        "MCP",        // MCP server disconnect, Web search API rate limit
  JOBS:       "JOBS",       // Cron scheduler error, BullMQ worker dead-letter
  ADMIN:      "ADMIN",      // Plan created/updated, node toggled, credits adjusted
  DEPLOYMENT: "DEPLOYMENT"  // Server boot heartbeat, version deployments
});

/**
 * Alert Severity Levels
 */
const SEVERITY = Object.freeze({
  INFO:     "INFO",
  WARN:     "WARN",
  ERROR:    "ERROR",
  CRITICAL: "CRITICAL"
});

module.exports = { ALERT_TYPES, SEVERITY };
