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

  try {
    const secret = process.env.JWT_SECRET || "mysecretkey";
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    if (req.user && !req.user.id && req.user._id) {
      req.user.id = req.user._id;
    }
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: "Invalid Token",
    });
  }
};

auth.protect = auth;

const { isUserAdmin } = require("../utils/adminConfig");

auth.requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Not authorized" });
    }

    let userDoc = null;
    try {
      userDoc = await User.findById(userId).lean();
    } catch (e) {
      console.warn("Could not find user in requireAdmin:", e.message);
    }

    const isAdmin = isUserAdmin(userDoc, req.user);

    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Access denied. Admin authorization required." });
    }
    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: "Server error in admin authorization" });
  }
};

module.exports = auth;