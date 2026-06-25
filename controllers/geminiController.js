const Chat = require("../models/Chat");
const Message = require("../models/Message");
const Summary = require("../models/Summary"); // Handles context fetching/saving
const { GoogleGenAI } = require("@google/genai");
const { sendMessageSchema } = require("../schemas/chatValidation");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.sendMessage = async (req, res) => {
  try {
    const validationResult = sendMessageSchema.safeParse(req.body);
    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        errors: validationResult.error.flatten().fieldErrors,
      });
    }

    const { message } = validationResult.data;
    let chatId = req.params.chatId;

    let chat;
    if (!chatId || chatId === "new" || chatId === "undefined") {
      chat = await Chat.create({
        userId: req.user.id,
        title: message.substring(0, 30) || "New Chat",
      });
      chatId = chat._id;
    } else {
      chat = await Chat.findById(chatId);
    }

    if (!chat) {
      return res
        .status(404)
        .json({ success: false, message: "Chat session not found" });
    }

    if (chat.title === "New Chat") {
      chat.title = message.substring(0, 30);
      await chat.save();
    }

    // 1. Save User message to Database
    await Message.create({
      chatId,
      role: "user",
      content: message,
    });

    // 2. Fetch the summarized context if it exists
    const existingSummary = await Summary.findOne({ chatId });

    // 3. Fetch only the last 4 messages to serve as recent context
    const dbMessagesHistory = await Message.find({ chatId })
      .sort({ createdAt: -1 })
      .limit(4);

    dbMessagesHistory.reverse();

    // 4. Assemble payload for Gemini API
    const historyPayload = [];

    // Inject summary context if present
    if (existingSummary && existingSummary.summarizedContent) {
      historyPayload.push({
        role: "user",
        parts: [
          {
            text: `[System Context Summary of previous conversation]: ${existingSummary.summarizedContent}`,
          },
        ],
      });
      historyPayload.push({
        role: "model",
        parts: [
          {
            text: "Understood. I will retain this context for the conversation.",
          },
        ],
      });
    }

    // Append recent messages
    dbMessagesHistory.forEach((msg) => {
      historyPayload.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    });

    // Set headers for Streaming Response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(
      `data: ${JSON.stringify({ type: "meta", chatId, title: chat.title })}\n\n`,
    );
    await delay(500);

    let responseStream;
    try {
      responseStream = await ai.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: historyPayload,
        //  ADDED THIS CONFIG OBJECT BELOW
        config: {
          systemInstruction: `You are a voice assistant. Users are listening to your responses out loud. Follow these instructions strictly:
1. Be extremely concise. Keep your answers to a maximum of 2 to 3 simple, short sentences.
2. Never use any Markdown formatting like asterisks (**), hashtags (#), bullet points, or code blocks. Speak in plain, fluid, natural paragraphs.
3. If a response requires a long list or complex code explanation, give a 1-sentence summary and state: "I have displayed the details below for you to read."`,
        },
      });
    } catch (apiError) {
      if (apiError.status === 429) {
        await delay(2000);
        responseStream = await ai.models.generateContentStream({
          model: "gemini-2.5-flash",
          contents: historyPayload,
          // ADDED THIS CONFIG OBJECT BELOW AS WELL FOR RETRIES
          config: {
            systemInstruction: `You are a voice assistant. Users are listening to your responses out loud. Follow these instructions strictly:
1. Be extremely concise. Keep your answers to a maximum of 2 to 3 simple, short sentences.
2. Never use any Markdown formatting like asterisks (**), hashtags (#), bullet points, or code blocks. Speak in plain, fluid, natural paragraphs.
3. If a response requires a long list or complex code explanation, give a 1-sentence summary and state: "I have displayed the details below for you to read."`,
          },
        });
      } else {
        throw apiError;
      }
    }

    let accumulatedReplyText = "";
    for await (const chunk of responseStream) {
      const chunkText = chunk.text || "";
      accumulatedReplyText += chunkText;
      res.write(
        `data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`,
      );
    }

    // 5. Save the complete Assistant message to Database
    const assistantMsg = await Message.create({
      chatId,
      role: "assistant",
      content: accumulatedReplyText,
    });

    res.write("data: [DONE]\n\n");
    res.end();

    // 6. BACKGROUND RUNTIME: Compress conversation history to summary
    process.nextTick(async () => {
      try {
        const totalMessagesCount = await Message.countDocuments({ chatId });

        // If the chat log gets longer than 4 messages, recalculate the summary context
        if (totalMessagesCount > 4) {
          const allMessages = await Message.find({ chatId }).sort({
            createdAt: 1,
          });

          const summaryPrompt = `Summarize the following chat conversation history accurately, highlighting key facts, goals, and metrics discussed while keeping it brief:\n\n${allMessages.map((m) => `${m.role}: ${m.content}`).join("\n")}`;

          const summaryResult = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: summaryPrompt,
          });

          await Summary.findOneAndUpdate(
            { chatId },
            {
              summarizedContent: summaryResult.text || "",
              lastUpdatedMessageId: assistantMsg._id,
            },
            { upsert: true, new: true },
          );
        }
      } catch (bgError) {
        console.error("Background summary generation failed:", bgError);
      }
    });
  } catch (error) {
    console.error("CRITICAL STREAM RUNTIME ERROR:", error);

    // Determine user-friendly messages based on status codes
    let uiMessage = "An unexpected server error occurred. Please try again.";
    let errorType = "SERVER_ERROR";

    if (error.status === 429 || error.message?.includes("429")) {
      uiMessage =
        "Daily Gemini request quota exceeded. Please wait a minute or upgrade your plan.";
      errorType = "QUOTA_EXCEEDED";
    } else if (error.status === 503 || error.message?.includes("503")) {
      uiMessage =
        "Gemini servers are currently experiencing high demand. Please try again in a few seconds.";
      errorType = "SERVER_OVERLOAD";
    }

    if (!res.headersSent) {
      res
        .status(error.status || 500)
        .json({ success: false, message: uiMessage, type: errorType });
    } else {
      // If the stream was already open, push a structured error event downstream
      res.write(
        `data: ${JSON.stringify({ type: "error", message: uiMessage, errorType })}\n\n`,
      );
      res.end();
    }
  }
};
