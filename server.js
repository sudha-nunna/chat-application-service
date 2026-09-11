// Reload server with updated botKeyAuth middleware
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");
const logger = require("./utils/logger");
const { correlationIdMiddleware, noSqlSanitizerMiddleware } = require("./middleware/security");

const chatRoutes = require("./routes/chatRoutes");
const ollamaRoutes = require("./routes/aiRoutes");
const authRoutes = require("./routes/authRoutes");
const botRoutes = require("./routes/botRoutes");
const externalBotRoutes = require("./routes/externalBotRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const planRoutes = require("./routes/planRoutes");
const adminRoutes = require("./routes/adminRoutes");
const seedAIModels = require("./utils/modelSeeder");
const { warmOllamaConnection } = require("./utils/ollamaHelper");
const { redis } = require("./utils/redisClient");
const { knowledgeQueue } = require("./utils/bullQueue");

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// ─── Process-level Safety Nets ───────────────────────────────────────────────

/**
 * Unhandled promise rejections — catch and log rather than silently crashing.
 * Express 5 propagates async errors automatically, but fire-and-forget calls
 * and third-party libraries can still produce unhandled rejections.
 */
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Promise Rejection — process continuing", {
    reason: reason instanceof Error ? reason.stack : String(reason),
    promise: String(promise),
  });
});

/**
 * Uncaught synchronous exceptions — log with full stack before Node's default behaviour.
 * We do NOT call process.exit() here intentionally; PM2/container orchestration handles restart.
 */
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception — process may be in unstable state", {
    error: err.message,
    stack: err.stack,
  });
  // Give in-flight requests a moment to finish, then exit (PM2 will restart)
  setTimeout(() => process.exit(1), 1000).unref();
});

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);

// ─── Security Headers (Helmet) ────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: false,           // Disabled — frontend manages its own CSP
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// ─── Request Correlation IDs (must be first — before routes & rate limiters) ──

app.use(correlationIdMiddleware);

// ─── Rate Limiters ────────────────────────────────────────────────────────────

const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests from this IP, please try again later." }
});
app.use("/api/", globalApiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many authentication requests, please try again later." }
});
app.use("/auth/login", authLimiter);
app.use("/auth/google", authLimiter);

// ─── CORS ─────────────────────────────────────────────────────────────────────

// 1. Public External Bot & Avatar CORS (Allows third-party websites/apps without token requirements)
app.use(["/api/v1/external/bots", "/api/v1/avatar"], cors({
  origin: "*",
  credentials: false,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Bot-Api-Key", "X-Bot-Secret-Key", "X-Visitor-Id", "x-visitor-id", "X-User-Plan", "x-user-plan", "x-auth-token"]
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => {
    let clean = origin.trim();
    if (!clean) return "";
    try {
      if (clean.startsWith("http://") || clean.startsWith("https://")) {
        return new URL(clean).origin;
      }
    } catch (e) {}
    return clean.replace(/\/$/, "");
  })
  .filter(Boolean);

// 2. Restricted CORS for internal dashboard & admin apps
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, or Postman)
    if (!origin) return callback(null, true);

    const isAllowed = allowedOrigins.length === 0 || allowedOrigins.some((allowed) => {
      if (allowed === "*") return true;
      if (allowed === origin) return true;
      try {
        const allowedOrigin = allowed.startsWith("http") ? new URL(allowed).origin : allowed;
        const incomingOrigin = new URL(origin).origin;
        return allowedOrigin === incomingOrigin;
      } catch (e) {
        return false;
      }
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn("CORS block", { origin, allowed: allowedOrigins });
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "X-Bot-Api-Key",
    "X-Bot-Secret-Key",
    "X-Visitor-Id",
    "x-visitor-id",
    "X-User-Plan",
    "x-user-plan",
    "x-auth-token"
  ]
}));

// ─── Upload Directory Bootstrap ───────────────────────────────────────────────

const path = require("path");
const fs = require("fs");

const uploadDirs = ["uploads", "uploads/audio", "uploads/avatars"];
uploadDirs.forEach((dir) => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// ─── Body Parsing ─────────────────────────────────────────────────────────────
//
// Security: Global JSON body limit is 2MB to prevent memory-exhaustion DoS attacks.
// Upload-specific routes (botRoutes, authRoutes) use their own multer middleware
// with explicit 25–50MB per-file limits. Base64 file payloads (uploadBotFile) also
// accept up to 25MB JSON bodies at the route level.
//
// Webhook endpoints skip JSON parsing to preserve raw body for signature verification.

app.use((req, res, next) => {
  const isWebhook = req.originalUrl === "/api/subscriptions/webhook"
    || req.originalUrl === "/subscription/webhook"
    || req.path === "/webhook"
    || (req.originalUrl && req.originalUrl.includes("/webhook"));

  if (isWebhook) {
    // Skip — handled by subscriptionController with raw body
    return next();
  }

  // Upload endpoints that send base64-encoded file content in JSON need a larger limit
  const isUploadJson = req.originalUrl.includes("/upload")
    || req.originalUrl.includes("/bot-file")
    || req.originalUrl.includes("/postman-import");

  const limit = isUploadJson ? "25mb" : "2mb";
  express.json({ limit })(req, res, next);
});

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ─── NoSQL Injection Sanitizer (after body parsing, before routes) ────────────

app.use(noSqlSanitizerMiddleware);

// ─── Routes ───────────────────────────────────────────────────────────────────

const projectRoutes = require("./routes/projectRoutes");
const modelRoutes = require("./routes/modelRoutes");
const usageRoutes = require("./routes/usageRoutes");
const creditRoutes = require("./routes/creditRoutes");
const agentStudioRoutes = require("./routes/agentStudioRoutes");

app.use("/chats", chatRoutes);
app.use("/chat", chatRoutes);
app.use("/auth", authRoutes);
app.use("/ollama", ollamaRoutes);
app.use("/bots", botRoutes);
app.use("/agents", agentStudioRoutes);
app.use("/api/v1/agents", agentStudioRoutes);
app.use("/api/v1/avatar", botRoutes);
app.use("/projects", projectRoutes);
app.use("/api/v1/external/bots", externalBotRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/plans", planRoutes);
app.use("/admin", adminRoutes);
app.use("/models", modelRoutes);
app.use("/api/v1/models", modelRoutes);
app.use("/usage", usageRoutes);
app.use("/api/usage", usageRoutes);
app.use("/api/v1/usage", usageRoutes);
app.use("/credits", creditRoutes);
app.use("/api/credits", creditRoutes);

const promoController = require("./controllers/promoController");
app.get("/offers/active", promoController.getActiveOffer);
app.get("/api/v1/offers/active", promoController.getActiveOffer);

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Health check endpoints for load balancers, container orchestration, and uptime monitors.
 * Returns 200 with service status — no authentication required.
 */
const healthHandler = (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "chat-application-service",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    environment: process.env.NODE_ENV || "development",
  });
};
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);
app.get("/api/v1/health", healthHandler);

// ─── Root ─────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("Server Running");
});

// ─── Global Error Handler ─────────────────────────────────────────────────────

const multer = require("multer");
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.name === "MulterError") {
    logger.warn("Multer file upload error", {
      correlationId: req.correlationId,
      error: err.message,
      field: err.field,
    });
    return res.status(400).json({
      error: `File upload error: ${err.message}${err.field ? ` (field '${err.field}')` : ""}`
    });
  }

  if (err) {
    logger.error("Unhandled route error", {
      correlationId: req.correlationId,
      error: err.message,
      stack: err.stack,
      path: req.originalUrl,
    });
    return res.status(err.status || 500).json({
      error: err.message || "Internal Server Error"
    });
  }
  next();
});

// ─── Server Start ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
let server;

async function startServer() {
  try {
    await connectDB();
    seedAIModels();
    warmOllamaConnection().catch((err) => {
      logger.warn("warmOllamaConnection failed at startup", { error: err.message });
    });

    server = app.listen(PORT, () => {
      logger.info("Server started", { port: PORT, env: process.env.NODE_ENV || "development" });
      const f5Url = process.env.F5_TTS_URL || process.env.VOICE_ENGINE_URL || "http://127.0.0.1:8000";
      logger.info("Voice synthesis endpoint configured", { url: f5Url });
    });
  } catch (err) {
    logger.error("Database connection failed — server cannot start", { error: err.message });
    process.exit(1);
  }
}

startServer();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

/**
 * Graceful shutdown on SIGTERM (sent by PM2, Docker, Kubernetes, Render).
 * 1. Stop accepting new connections
 * 2. Wait up to 10s for in-flight requests to complete
 * 3. Close DB + Redis connections
 * 4. Exit with code 0 (clean)
 */
async function gracefulShutdown(signal) {
  logger.info(`${signal} received — initiating graceful shutdown`);

  const closeCb = async () => {
    logger.info("HTTP server closed — no new connections accepted");

    // Close Redis connection
    try {
      if (redis && redis.status !== "end") {
        await redis.quit();
        logger.info("Redis connection closed");
      }
    } catch (e) {
      logger.warn("Redis close notice", { error: e.message });
    }

    // Close Mongoose / MongoDB
    try {
      const mongoose = require("mongoose");
      await mongoose.connection.close();
      logger.info("MongoDB connection closed");
    } catch (e) {
      logger.warn("MongoDB close notice", { error: e.message });
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  };

  if (server) {
    server.close(closeCb);
  } else {
    closeCb();
  }

  // Force exit after 10s if shutdown hangs
  setTimeout(() => {
    logger.error("Graceful shutdown timeout — forcing exit");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));