const jwt = require("jsonwebtoken");

const { redis } = require("../utils/redisClient");
const User = require("../models/User");

const auth = async (req, res, next) => {
  const authHeader = req.headers.authorization || req.headers["x-auth-token"];
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: "No token found",
    });
  }

  let token = String(authHeader).trim();
  if (token.startsWith("Bearer ") || token.includes(" ")) {
    token = token.split(" ")[1];
  }

  if (!token || token === "null" || token === "undefined") {
    return res.status(401).json({
      success: false,
      message: "No token found",
    });
  }

  let decoded;
  try {
    const secret = process.env.JWT_SECRET || "mysecretkey";
    decoded = jwt.verify(token, secret);
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid Token",
    });
  }
};

auth.protect = auth;

auth.requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Not authorized" });
    }
    const SUPER_ADMIN_EMAILS = ["sairamakrishna2@gmail.com", "saiphanindra8520@gmail.com"];
    const isAdmin = userDoc && (userDoc.role === "admin" || userDoc.isAdmin || (userDoc.email && SUPER_ADMIN_EMAILS.includes(userDoc.email.toLowerCase())));

    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Access denied. Admin authorization required." });
    }
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: "Server error in admin authorization" });
  }
};

module.exports = auth;