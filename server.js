require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

const chatRoutes = require("./routes/chatRoutes");
const ollamaRoutes = require("./routes/aiRoutes");
const authRoutes = require("./routes/authRoutes");
const botRoutes = require("./routes/botRoutes");
connectDB();
const app = express();

app.use(cors({
  origin: "http://localhost:5173" || "https://chat-application-app-gold.vercel.app/",
  credentials: true
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api/chats", chatRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/ollama", ollamaRoutes);
app.use("/api/bots", botRoutes);

app.get("/", (req, res) => {
  res.send("Server Running");
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on port ${process.env.PORT}`
  );
});