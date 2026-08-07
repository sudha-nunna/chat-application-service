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

// 1. Public External Bot Widget CORS (Allows third-party websites/apps using API Keys)
// Must be declared BEFORE global restricted CORS middleware
app.use("/api/v1/external/bots", cors({
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

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/chats", chatRoutes);
app.use("/auth", authRoutes);
app.use("/ollama", ollamaRoutes);
app.use("/bots", botRoutes);
app.use("/api/v1/external/bots", externalBotRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/plans", planRoutes);
app.use("/admin", adminRoutes);

app.get("/", (req, res) => {
  res.send("Server Running");
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on port ${process.env.PORT}`
  );

  warmOllamaConnection().then((success) => {
    if (!success) {
      console.warn("⚠️ [SERVER STARTUP] Ollama warmup did not complete successfully.");
    }
  });
});