// Reload server with updated botKeyAuth middleware
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

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

connectDB().then(() => {
  seedAIModels();
  warmOllamaConnection().catch(() => {});
});

const app = express();
app.set("trust proxy", 1);

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
      console.warn(`⚠️ [CORS BLOCK] Origin '${origin}' rejected. Allowed origins:`, allowedOrigins);
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

const path = require("path");
const fs = require("fs");

// Ensure upload directories exist
const uploadDirs = ["uploads", "uploads/audio", "uploads/avatars"];
uploadDirs.forEach((dir) => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const projectRoutes = require("./routes/projectRoutes");
const modelRoutes = require("./routes/modelRoutes");
const usageRoutes = require("./routes/usageRoutes");
const creditRoutes = require("./routes/creditRoutes");
app.use("/chats", chatRoutes);
app.use("/auth", authRoutes);
app.use("/ollama", ollamaRoutes);
app.use("/bots", botRoutes);
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
app.use("/api/v1/credits", creditRoutes);


app.get("/", (req, res) => {
  res.send("Server Running");
});

// Express Global Error Handler (Handles Multer errors gracefully without stack trace crashes)
const multer = require("multer");
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.name === "MulterError") {
    console.warn("⚠️ [MULTER HANDLER] Managed file upload notice:", err.message, err.field ? `(field: ${err.field})` : "");
    return res.status(400).json({
      error: `File upload error: ${err.message}${err.field ? ` (field '${err.field}')` : ""}`
    });
  }
  if (err) {
    console.error("⚠️ [UNHANDLED ERROR]", err.stack || err);
    return res.status(err.status || 500).json({
      error: err.message || "Internal Server Error"
    });
  }
  next();
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on port ${process.env.PORT}`
  );

  const f5Url = process.env.F5_TTS_URL || process.env.VOICE_ENGINE_URL || "http://127.0.0.1:8000";
  console.log(`🎤 [VOICE SERVICE] Voice synthesis endpoint configured at: ${f5Url}`);

  warmOllamaConnection().then((success) => {
    if (!success) {
      console.warn("⚠️ [SERVER STARTUP] Ollama warmup did not complete successfully.");
    }
  });
});