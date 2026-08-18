const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { redis } = require("../utils/redisClient");

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
      error: err.message,
    });
  }

  const userId = decoded.id || decoded._id;
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Invalid Token Payload",
    });
  }

  try {
    // High-Speed Redis Session Check (<0.5ms)
    const sessionKey = `user:session:${userId}`;

    if (redis && redis.status === "ready") {
      const cachedStatus = await redis.get(sessionKey).catch(() => null);
      if (cachedStatus === "0") {
        return res.status(401).json({
          success: false,
          code: "USER_DELETED",
          message: "User account no longer exists in database.",
        });
      }
      if (cachedStatus === "1") {
        req.user = decoded;
        return next();
      }
    }

    // Database Verification
    const dbUser = await User.findById(userId).select("_id email name").catch(() => null);
    if (!dbUser) {
      if (redis && redis.status === "ready") {
        await redis.set(sessionKey, "0", "EX", 300).catch(() => {});
      }
      return res.status(401).json({
        success: false,
        code: "USER_DELETED",
        message: "User account no longer exists in database.",
      });
    }

    if (redis && redis.status === "ready") {
      await redis.set(sessionKey, "1", "EX", 300).catch(() => {});
    }

    req.user = decoded;
    return next();
  } catch (err) {
    req.user = decoded;
    return next();
  }
};

module.exports = auth;