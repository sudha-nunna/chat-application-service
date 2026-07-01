require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

const chatRoutes = require("./routes/chatRoutes");
const ollamaRoutes=require("./routes/aiRoutes")
// const geminiRoutes = require("./routes/geminiRoutes");
const authRoutes = require("./routes/authRoutes");
connectDB();
const app = express();



app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));

app.use(express.json());

app.use("/api/chats", chatRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/ollama", ollamaRoutes);
// app.use("/api/gemini", geminiRoutes);

app.get("/", (req, res) => {
  res.send("Server Running");
});

app.listen(process.env.PORT, () => {
  console.log(
    `Server running on port ${process.env.PORT}`
  );
});