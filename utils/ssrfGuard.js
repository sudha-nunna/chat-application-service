/**
 * SSRF Guard — utils/ssrfGuard.js
 *
 * Validates user-configurable URLs against SSRF attack vectors.
 * Blocks attempts to reach internal infrastructure, cloud metadata endpoints,
 * and private network ranges.
 *
 * Behaviour by environment:
 *   - Development (NODE_ENV !== "production"):
 *       localhost / 127.0.0.1 are ALLOWED (for local Ollama, dev servers)
 *   - Production (NODE_ENV === "production"):
 *       All private ranges BLOCKED — 10.x, 172.16-31.x, 192.168.x, 127.x, etc.
 *
 * Usage:
 *   const { validateUrl, assertSafeUrl } = require('./utils/ssrfGuard');
 *   const result = validateUrl('http://192.168.1.10:11434'); // { valid: false, error: '...' }
 *   assertSafeUrl('https://api.openai.com');                 // throws on unsafe
 */

"use strict";

// Evaluated lazily per-call so NODE_ENV changes in tests are respected,
// and so the value is always current in long-running processes.
const isProd = () => process.env.NODE_ENV === "production";

// ─── Blocklists ──────────────────────────────────────────────────────────────

/** IP ranges blocked only in production (private / RFC-special) */
const PRIVATE_IP_RANGES = [
  /^0\./,                                     // 0.0.0.0/8 — this network
  /^10\./,                                    // 10.0.0.0/8 — RFC 1918 private
  /^100\.64\./,                               // 100.64.0.0/10 — shared address space (RFC 6598)
  /^127\./,                                   // 127.0.0.0/8 — loopback
  /^169\.254\./,                              // 169.254.0.0/16 — link-local / AWS metadata
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,          // 172.16.0.0–172.31.255.255 — RFC 1918 private
  /^192\.0\.0\./,                             // 192.0.0.0/24 — IANA special
  /^192\.168\./,                              // 192.168.0.0/16 — RFC 1918 private
  /^198\.18\./,                               // 198.18.0.0/15 — benchmarking
  /^198\.51\.100\./,                          // TEST-NET-2 (RFC 5737)
  /^203\.0\.113\./,                           // TEST-NET-3 (RFC 5737)
  /^240\./,                                   // 240.0.0.0/4 — reserved
];

/** Hostnames / patterns ALWAYS blocked regardless of environment */
const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",    // Universal cloud metadata IP (AWS, GCP, Azure, DigitalOcean)
  "::1",               // IPv6 loopback
]);

const ALWAYS_BLOCKED_HOSTNAME_PATTERNS = [
  /^169\.254\./i,                             // Cloud metadata range
  /metadata\.google\.internal$/i,             // GCP metadata
  /\.internal$/i,                             // Internal service-discovery hostnames
  /^fd[0-9a-f]{2}:/i,                         // IPv6 ULA (fd00::/8)
  /^fe80:/i,                                  // IPv6 link-local
];

// ─── Core validation ─────────────────────────────────────────────────────────

/**
 * Validates a URL against SSRF blocklist.
 *
 * @param {string} rawUrl  - The URL to validate (e.g., from admin input)
 * @param {object} options
 * @param {boolean} [options.allowLocalhost=false] - Override: allow localhost in any env
 * @returns {{ valid: boolean, error?: string, hostname?: string }}
 */
function validateUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { valid: false, error: "URL is required." };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, error: `Invalid URL format: "${rawUrl}"` };
  }

  // Only allow HTTP and HTTPS
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      valid: false,
      error: `Protocol "${parsed.protocol}" is not allowed. Only HTTP and HTTPS are permitted.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // ── Always-blocked hostnames ──────────────────────────────────────────────
  if (ALWAYS_BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: `Hostname "${hostname}" is blocked (cloud metadata / internal endpoint).` };
  }

  for (const pattern of ALWAYS_BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, error: `Hostname "${hostname}" matches a blocked pattern (internal/metadata).` };
    }
  }

  // ── Environment-specific private range checks ─────────────────────────────
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

  if (isProd() && isLoopback && !options.allowLocalhost) {
    return {
      valid: false,
      error: `Localhost addresses are not permitted in production. Use a public endpoint.`,
    };
  }

  if (isProd()) {
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(hostname)) {
        return {
          valid: false,
          error: `Private IP range not permitted in production: "${hostname}". Use a publicly accessible endpoint.`,
        };
      }
    }
  }

  return { valid: true, hostname };
}

/**
 * Throws an Error if the URL fails SSRF validation.
 * Suitable for use inside async controller functions.
 *
 * @param {string} rawUrl
 * @param {object} options
 */
function assertSafeUrl(rawUrl, options = {}) {
  const result = validateUrl(rawUrl, options);
  if (!result.valid) {
    const err = new Error(result.error);
    err.code = "SSRF_BLOCKED";
    throw err;
  }
}

module.exports = { validateUrl, assertSafeUrl };
