/**
 * Centralized Admin Configuration & Helpers
 * Handles bootstrap admin emails (via ENV or default fallback)
 * and verifies admin privileges based on MongoDB role as the primary source of truth.
 */

const DEFAULT_SUPER_ADMINS = [
  "sairamakrishna2@gmail.com",
  "saiphanindra8520@gmail.com",
  "nunnasudha03@gmail.com"
];

function getBootstrapAdminEmails() {
  const envEmails = process.env.SUPER_ADMIN_EMAILS || process.env.INITIAL_ADMIN_EMAILS;
  if (envEmails && typeof envEmails === "string") {
    const list = envEmails
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (list.length > 0) return Array.from(new Set([...list, ...DEFAULT_SUPER_ADMINS]));
  }
  return DEFAULT_SUPER_ADMINS;
}

const BOOTSTRAP_ADMIN_EMAILS = getBootstrapAdminEmails();

/**
 * Checks if a user is an admin.
 * Primary source of truth: user document in MongoDB (role === 'admin' or isAdmin === true).
 * Fallback: bootstrap emails configured in environment or initial defaults.
 */
function isUserAdmin(userDoc, tokenPayload = {}) {
  const role = (userDoc?.role || tokenPayload?.role || "").toLowerCase();
  const isAdminFlag = userDoc?.isAdmin === true || tokenPayload?.isAdmin === true;
  const email = (userDoc?.email || tokenPayload?.email || "").toLowerCase().trim();

  if (role === "admin" || isAdminFlag) {
    return true;
  }

  if (email && BOOTSTRAP_ADMIN_EMAILS.includes(email)) {
    return true;
  }

  return false;
}

module.exports = {
  BOOTSTRAP_ADMIN_EMAILS,
  isUserAdmin
};
