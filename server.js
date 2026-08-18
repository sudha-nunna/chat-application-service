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
const seedPlans = require("./utils/planSeeder");
const { warmOllamaConnection } = require("./utils/ollamaHelper");
const { redis } = require("./utils/redisClient");
const { knowledgeQueue } = require("./utils/bullQueue");

connectDB().then(() => {
  seedPlans();
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
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

// 2. Restricted CORS for internal dashboard
app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
  credentials: true
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

  // Auto-spawn Python F5-TTS Voice Engine as child process
  try {
    const { spawn } = require("child_process");

    // Resolve Python binary path with fallback sequence:
    // 1. process.env.PYTHON_PATH (if set)
    // 2. Local venv path for Windows (venv/Scripts/python.exe) or Linux (venv/bin/python)
    // 3. System python / python3 binary
    let venvPythonPath = process.env.PYTHON_PATH;
    const defaultWinPath = path.join(__dirname, "venv/Scripts/python.exe");
    const defaultUnixPath = path.join(__dirname, "venv/bin/python");
    const openvoiceScriptPath = path.join(__dirname, "voice_engine/openvoice_service.py");

    if (!venvPythonPath) {
      if (fs.existsSync(defaultWinPath)) {
        venvPythonPath = defaultWinPath;
      } else if (fs.existsSync(defaultUnixPath)) {
        venvPythonPath = defaultUnixPath;
      } else {
        venvPythonPath = process.platform === "win32" ? "python" : "python3";
      }
    } else if (!path.isAbsolute(venvPythonPath) && (venvPythonPath.includes("/") || venvPythonPath.includes("\\"))) {
      venvPythonPath = path.resolve(__dirname, venvPythonPath);
    }

    const pyExists = fs.existsSync(venvPythonPath) || (!venvPythonPath.includes("/") && !venvPythonPath.includes("\\"));

    if (pyExists && fs.existsSync(openvoiceScriptPath)) {
      // Auto-cleanup orphan sockets on port 8000 to ensure fresh attached process with live terminal logs
      try {
        const { execSync } = require("child_process");
        if (process.platform === "win32") {
          execSync('powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', { stdio: "ignore" });
        } else {
          execSync("fuser -k 8000/tcp || true", { stdio: "ignore" });
        }
      } catch (e) { }

      console.log(`🚀 Spawning Python OpenVoice V2 Engine (${venvPythonPath})...`);
      const pyProc = spawn(venvPythonPath, [openvoiceScriptPath], {
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", VOICE_ENGINE_PORT: "8000", PORT: "8000" }
      });

      pyProc.stdout.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[OpenVoice V2] ${msg}`);
      });

      pyProc.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("DeprecationWarning") && !msg.includes("unauthenticated requests") && !msg.includes("HF_TOKEN")) {
          console.log(`[OpenVoice LOG] ${msg}`);
        }
      });

      const killPyProc = () => {
        if (pyProc && !pyProc.killed) {
          console.log("Shutting down Python OpenVoice Engine...");
          pyProc.kill("SIGTERM");
        }
      };

      process.on("exit", killPyProc);
      process.on("SIGINT", () => { killPyProc(); process.exit(); });
      process.on("SIGTERM", () => { killPyProc(); process.exit(); });
    }
  } catch (pyErr) {
    console.warn("Notice: Python F5-TTS child process spawn notice:", pyErr.message);
  }

  warmOllamaConnection().then((success) => {
    if (!success) {
      console.warn("⚠️ [SERVER STARTUP] Ollama warmup did not complete successfully.");
    }
  });
});