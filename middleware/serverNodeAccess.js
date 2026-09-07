const User = require("../models/User");
const { isUserAdmin } = require("../utils/adminConfig");

/**
 * Access control middleware for protected servernodes collection:
 * - Human Admin: Full CRUD (GET, POST, PUT, PATCH, DELETE)
 * - AI Agent: Read-only (GET allowed, write operations blocked with 403)
 *   - Primary check: req.user.type === "agent"
 *   - Fallback check: req.headers["x-caller-type"] === "agent"
 * - Normal User: Blocked with 403
 */
const serverNodeAccessControl = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId && !req.user) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    // Admin Check
    let userDoc = null;
    if (userId) {
      try {
        userDoc = await User.findById(userId).lean();
      } catch (e) {
        // Continue with req.user claims if DB lookup fails
      }
    }

    const isAdmin = isUserAdmin(userDoc, req.user);

    if (isAdmin) {
      return next();
    }

    const isAgent =
      req.user?.type === "agent" ||
      String(req.headers["x-caller-type"] || "").toLowerCase() === "agent";

    if (isAgent) {
      if (req.method === "GET") {
        return next();
      }

      return res.status(403).json({
        success: false,
        error: "Access Denied: AI Agents have read-only access to server nodes."
      });
    }

    return res.status(403).json({
      success: false,
      error: "Access denied. Admin authorization required."
    });
  } catch (err) {
    console.error("Error in serverNodeAccessControl:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error in server node authorization"
    });
  }
};

module.exports = {
  serverNodeAccessControl
};
