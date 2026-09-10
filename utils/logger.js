/**
 * Structured Logger — utils/logger.js
 * Lightweight, zero-dependency structured logger.
 * - Production: emits newline-delimited JSON (compatible with Datadog, CloudWatch, GCP Logging)
 * - Development: human-readable coloured console output
 *
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started', { port: 3000 });
 *   logger.child('req-abc').warn('Auth failed', { userId });
 */

"use strict";

const IS_PROD = process.env.NODE_ENV === "production";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevelValue = LEVELS[LOG_LEVEL] ?? LEVELS.info;

/**
 * Formats a log entry. Production → JSON. Development → readable string.
 */
function formatEntry(level, message, meta) {
  const ts = new Date().toISOString();

  if (IS_PROD) {
    return JSON.stringify({ ts, level, message, ...meta });
  }

  const cid = meta.correlationId ? ` [${meta.correlationId}]` : "";
  const extraKeys = Object.keys(meta).filter((k) => k !== "correlationId");
  const extra = extraKeys.length > 0
    ? " " + JSON.stringify(Object.fromEntries(extraKeys.map((k) => [k, meta[k]])))
    : "";

  const prefix = {
    error: "❌ [ERROR]",
    warn:  "⚠️  [WARN] ",
    info:  "ℹ️  [INFO] ",
    debug: "🔍 [DEBUG]",
  }[level] || `[${level.toUpperCase()}]`;

  return `${ts} ${prefix}${cid} ${message}${extra}`;
}

/**
 * Core write function — routes to appropriate console method and respects log level.
 */
function write(level, message, meta = {}) {
  if ((LEVELS[level] ?? 99) > currentLevelValue) return;
  const line = formatEntry(level, String(message), meta);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

const logger = {
  error: (message, meta = {}) => write("error", message, meta),
  warn:  (message, meta = {}) => write("warn",  message, meta),
  info:  (message, meta = {}) => write("info",  message, meta),
  debug: (message, meta = {}) => write("debug", message, meta),

  /**
   * Creates a child logger pre-bound to a correlation ID.
   * Child loggers automatically inject correlationId into every log entry.
   * @param {string} correlationId
   */
  child(correlationId) {
    return {
      error: (message, meta = {}) => write("error", message, { correlationId, ...meta }),
      warn:  (message, meta = {}) => write("warn",  message, { correlationId, ...meta }),
      info:  (message, meta = {}) => write("info",  message, { correlationId, ...meta }),
      debug: (message, meta = {}) => write("debug", message, { correlationId, ...meta }),
    };
  },
};

module.exports = logger;
