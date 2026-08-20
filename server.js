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

  // Auto-spawn Python Voice Engine (F5-TTS / OpenVoice) as child process
  try {
    const { spawn } = require("child_process");

    // Resolve active voice engine based on VOICE_CLONE_ENGINE env variable ("F5" | "OPENVOICE")
    const activeEngineType = (process.env.VOICE_CLONE_ENGINE || "F5").toUpperCase();
    const standaloneF5Path = path.join(__dirname, "../f5-voice-service/f5_tts_service.py");
    const localF5Path = path.join(__dirname, "voice_engine_f5/f5_tts_service.py");
    const f5ScriptPath = fs.existsSync(standaloneF5Path) ? standaloneF5Path : localF5Path;
    const openvoiceScriptPath = path.join(__dirname, "voice_engine/openvoice_service.py");

    let voiceScriptPath = (activeEngineType === "F5" || activeEngineType === "F5TTS") ? f5ScriptPath : openvoiceScriptPath;
    let engineLabel = (activeEngineType === "F5" || activeEngineType === "F5TTS") ? "F5-TTS" : "OpenVoice V2";

    if (!fs.existsSync(voiceScriptPath)) {
      voiceScriptPath = fs.existsSync(f5ScriptPath) ? f5ScriptPath : openvoiceScriptPath;
      engineLabel = voiceScriptPath === f5ScriptPath ? "F5-TTS" : "OpenVoice V2";
    }

    // Resolve Python binary path sequence:
    // 1. process.env.PYTHON_PATH (if set)
    // 2. Local venv path for Windows (venv/Scripts/python.exe) or Linux (venv/bin/python)
    // 3. System python / python3 binary
    let venvPythonPath = process.env.PYTHON_PATH;
    const defaultWinPath = path.join(__dirname, "venv/Scripts/python.exe");
    const defaultUnixPath = path.join(__dirname, "venv/bin/python");

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

    if (pyExists && fs.existsSync(voiceScriptPath)) {
      // Auto-cleanup orphan sockets on port 8000 to ensure attached process starts cleanly with live terminal logs
      try {
        const { execSync } = require("child_process");
        if (process.platform === "win32") {
          execSync('powershell -Command "Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', { stdio: "ignore" });
        } else {
          execSync("fuser -k 8000/tcp || true", { stdio: "ignore" });
        }
      } catch (e) { }

      console.log(`🚀 Spawning Python ${engineLabel} Engine (${venvPythonPath})...`);
      const pyProc = spawn(venvPythonPath, [voiceScriptPath], {
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", VOICE_ENGINE_PORT: "8000", PORT: "8000", VOICE_CLONE_ENGINE: activeEngineType }
      });

      pyProc.stdout.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[${engineLabel}] ${msg}`);
      });

      pyProc.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("DeprecationWarning") && !msg.includes("unauthenticated requests") && !msg.includes("HF_TOKEN")) {
          console.log(`[${engineLabel} LOG] ${msg}`);
        }
      });

      const killPyProc = () => {
        if (pyProc && !pyProc.killed) {
          console.log(`Shutting down Python ${engineLabel} Engine...`);
          try {
            pyProc.kill("SIGTERM");
          } catch (e) {
            try { pyProc.kill("SIGKILL"); } catch (err) {}
          }
        }
      };

      process.on("exit", killPyProc);
      process.on("SIGINT", () => { killPyProc(); process.exit(); });
      process.on("SIGTERM", () => { killPyProc(); process.exit(); });
      process.on("uncaughtException", (err) => {
        console.error("Uncaught Exception in server:", err);
        killPyProc();
        process.exit(1);
      });
    }
  } catch (pyErr) {
    console.warn("Notice: Python Voice Engine child process spawn notice:", pyErr.message);
  }

  warmOllamaConnection().then((success) => {
    if (!success) {
      console.warn("⚠️ [SERVER STARTUP] Ollama warmup did not complete successfully.");
    }
  });
});