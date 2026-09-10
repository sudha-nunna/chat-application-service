/**
 * Security Middleware Bundle — middleware/security.js
 *
 * Provides:
 *  1. correlationIdMiddleware  — Injects X-Correlation-Id into every request/response
 *  2. noSqlSanitizerMiddleware — Strips $ operator keys from body/query/params (NoSQL injection defense)
 *  3. sanitizeXss              — String-level XSS sanitizer (server-side backstop)
 *  4. auditLog                 — Structured audit trail for admin/sensitive actions
 *
 * Apply in server.js (before routes) with:
 *   const { correlationIdMiddleware, noSqlSanitizerMiddleware } = require('./middleware/security');
 *   app.use(correlationIdMiddleware);
 *   app.use(noSqlSanitizerMiddleware);
 */

"use strict";

const crypto = require("crypto");
const logger = require("../utils/logger");

// ─── 1. Correlation ID ────────────────────────────────────────────────────────

/**
 * Injects a unique X-Correlation-Id header into every request and response.
 * Honours upstream headers from load balancers / API gateways:
 *   X-Correlation-Id, X-Request-Id, CF-Ray (Cloudflare)
 *
 * Downstream consumers can read `req.correlationId` in any controller/middleware.
 */
function correlationIdMiddleware(req, res, next) {
  // Honour upstream-set correlation IDs (CDN, ALB, API gateway)
  const upstream =
    req.headers["x-correlation-id"] ||
    req.headers["x-request-id"] ||
    req.headers["cf-ray"]; // Cloudflare Ray ID

  const correlationId = upstream || crypto.randomUUID();

  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);

  next();
}

// ─── 2. NoSQL Injection Sanitizer ─────────────────────────────────────────────

/**
 * Recursively removes keys that begin with `$` from plain objects.
 * Prevents MongoDB operator injection attacks such as:
 *   POST /auth/login  { "email": { "$gt": "" }, "password": { "$gt": "" } }
 *
 * Mongoose strict: true provides database-level protection, but this is a
 * defense-in-depth layer that stops malicious data from reaching query builders.
 *
 * @param {unknown} obj    - Value to sanitize
 * @param {number}  depth  - Recursion depth guard (max 10)
 */
function sanitizeObject(obj, depth = 0) {
  // Guard: never recurse beyond 10 levels (prevents stack overflow on pathological inputs)
  if (depth > 10) return obj;
  if (obj === null || typeof obj !== "object" || Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeObject(item, depth + 1));

  const cleaned = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$")) {
      // Log the blocked key so security teams can investigate
      logger.warn("NoSQL injection key blocked by sanitizer", {
        key,
        source: "noSqlSanitizerMiddleware",
      });
      continue; // Drop the key entirely
    }
    cleaned[key] = sanitizeObject(obj[key], depth + 1);
  }
  return cleaned;
}

/**
 * Express middleware: sanitizes req.body, req.query, and req.params.
 * Safe to apply globally — only removes unexpected `$`-prefixed keys which are
 * never used intentionally in our API payload contracts.
 */
function noSqlSanitizerMiddleware(req, res, next) {
  try {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      req.body = sanitizeObject(req.body);
    }
    if (req.query && typeof req.query === "object") {
      req.query = sanitizeObject(req.query);
    }
    if (req.params && typeof req.params === "object") {
      req.params = sanitizeObject(req.params);
    }
  } catch (err) {
    // Never let the sanitizer crash the request pipeline
    logger.warn("NoSQL sanitizer encountered an error (non-fatal)", {
      error: err.message,
      path: req.originalUrl,
    });
  }
  next();
}

// ─── 3. XSS Sanitizer ────────────────────────────────────────────────────────

/**
 * Basic server-side XSS sanitizer for string values.
 * Strips inline <script> blocks and on* event handler attributes.
 * This is a backstop — primary XSS protection should live in the frontend (DOMPurify etc.)
 *
 * @param {unknown} input - String to sanitize
 * @returns {unknown} Sanitized string, or original value if not a string
 */
function sanitizeXss(input) {
  if (typeof input !== "string") return input;
  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")   // Remove <script> blocks
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")                  // Remove on* handlers (double-quoted)
    .replace(/on\w+\s*=\s*'[^']*'/gi, "")                  // Remove on* handlers (single-quoted)
    .replace(/javascript\s*:/gi, "");                       // Remove javascript: pseudo-protocol
}

// ─── 4. Audit Logger ──────────────────────────────────────────────────────────

/**
 * Writes a structured audit log entry for sensitive/admin actions.
 * Ingested automatically by log aggregators (Datadog, CloudWatch, etc.)
 *
 * @param {string} action - Short human-readable action description (e.g. "CREDIT_ADJUSTMENT")
 * @param {object} req    - Express request object (for userId, IP, correlationId)
 * @param {object} extra  - Additional structured context to include in the log
 */
function auditLog(action, req, extra = {}) {
  const userId = String(req.user?.id || req.user?._id || "anonymous");
  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  logger.info(`[AUDIT] ${action}`, {
    correlationId: req.correlationId || "-",
    userId,
    ip,
    method: req.method,
    path: req.originalUrl,
    userAgent: req.headers["user-agent"] || "-",
    ...extra,
  });
}

module.exports = {
  correlationIdMiddleware,
  noSqlSanitizerMiddleware,
  sanitizeObject,
  sanitizeXss,
  auditLog,
};
