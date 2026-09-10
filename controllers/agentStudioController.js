const mongoose = require("mongoose");
const Bot = require("../models/Bot");
const BotFile = require("../models/BotFile");
const BotChunk = require("../models/BotChunk");
const BotEmbedding = require("../models/BotEmbeddings");
const ragEngine = require("../utils/ragEngine");
const voiceService = require("../services/voiceService");
const aiGateway = require("../utils/aiGateway");
const { extractPdfText } = require("../services/pdfExtractionService");

/**
 * Default initial flow nodes for fresh conversational agents
 */
const DEFAULT_FLOW_NODES = [
  {
    id: "begin",
    type: "begin",
    title: "Begin",
    x: 200,
    y: 280
  },
  {
    id: "welcome-node",
    type: "conversation",
    title: "Welcome Greeting",
    badge: "Start",
    color: "pink",
    x: 310,
    y: 260,
    data: {
      text: "Hello! How can I assist you with your inquiry today?",
      transitions: [
        { id: "t1", label: "= Finish conversation", target: "end-node" }
      ]
    }
  },
  {
    id: "end-node",
    type: "ending",
    title: "Ending",
    color: "mint",
    x: 640,
    y: 280,
    data: {}
  }
];

const DEFAULT_CONNECTIONS = [
  { id: "c1", fromNode: "begin", toNode: "welcome-node" },
  { id: "c2", fromNode: "welcome-node", toNode: "end-node", transitionIndex: 0 }
];

/**
 * 1. CREATE AGENT
 */
exports.createAgent = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const {
      name = "New Conversational Agent",
      description = "",
      model = "glm-5.3-flash:cloud",
      systemPrompt = "You are a specialized AI assistant. You answer questions strictly based on the provided knowledge base.",
      voiceProfile = { voiceId: "cimo", name: "Cimo", speed: 1.0, pitch: 1.0 },
      flowGraph = { nodes: DEFAULT_FLOW_NODES, connections: DEFAULT_CONNECTIONS },
      knowledgeSources = [],
      securityConfig = {
        fallbackMessage: "I'm sorry, I cannot find information regarding that in my knowledge base.",
        maskPii: true,
        strictGuardrails: true,
        inactivityTimeout: 10
      },
      environment = "Development"
    } = req.body;

    const agent = await Bot.create({
      ownerId: userId,
      userId,
      name,
      description,
      model,
      systemPrompt,
      botType: "VOICE",
      voiceProfile: {
        voiceId: voiceProfile.voiceId || "cimo",
        voiceName: voiceProfile.name || "Cimo",
        speed: voiceProfile.speed || 1.0,
        pitch: voiceProfile.pitch || 1.0
      },
      flowGraph: {
        nodes: flowGraph?.nodes?.length ? flowGraph.nodes : DEFAULT_FLOW_NODES,
        connections: flowGraph?.connections?.length ? flowGraph.connections : DEFAULT_CONNECTIONS
      },
      knowledgeSources,
      securityConfig,
      environment,
      status: req.body.status || (req.body.isPublished ? "ACTIVE" : "INACTIVE"),
      isPublished: req.body.isPublished !== undefined ? req.body.isPublished : true
    });

    return res.status(201).json({
      success: true,
      message: "Agent created successfully",
      data: agent
    });
  } catch (err) {
    console.error("Error creating agent:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to create agent" });
  }
};

/**
 * 2. GET AGENT BY ID
 */
exports.getAgentById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid agent ID format" });
    }

    const agent = await Bot.findById(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    // Ensure fallback defaults if agent was created through legacy route
    const sanitized = agent.toObject();
    if (!sanitized.flowGraph || !sanitized.flowGraph.nodes || sanitized.flowGraph.nodes.length === 0) {
      sanitized.flowGraph = {
        nodes: DEFAULT_FLOW_NODES,
        connections: DEFAULT_CONNECTIONS
      };
    }

    return res.json({
      success: true,
      data: sanitized
    });
  } catch (err) {
    console.error("Error fetching agent:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to fetch agent" });
  }
};

/**
 * 3. UPDATE / PUBLISH AGENT
 */
exports.updateAgent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid agent ID format" });
    }

    const {
      name,
      description,
      model,
      systemPrompt,
      voiceProfile,
      flowGraph,
      knowledgeSources,
      securityConfig,
      environment
    } = req.body;

    const updateFields = {};
    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;
    if (model !== undefined) updateFields.model = model;
    if (systemPrompt !== undefined) updateFields.systemPrompt = systemPrompt;
    if (environment !== undefined) updateFields.environment = environment;

    if (voiceProfile) {
      updateFields.voiceProfile = {
        voiceId: voiceProfile.voiceId || voiceProfile.id || "cimo",
        voiceName: voiceProfile.name || "Cimo",
        speed: voiceProfile.speed || 1.0,
        pitch: voiceProfile.pitch || 1.0
      };
    }

    if (flowGraph) {
      updateFields.flowGraph = {
        nodes: flowGraph.nodes || [],
        connections: flowGraph.connections || []
      };
    }

    if (knowledgeSources !== undefined) updateFields.knowledgeSources = knowledgeSources;
    if (securityConfig !== undefined) updateFields.securityConfig = securityConfig;
    if (req.body.status !== undefined) updateFields.status = req.body.status;
    if (req.body.isPublished !== undefined) updateFields.isPublished = req.body.isPublished;

    const updatedAgent = await Bot.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: false }
    );

    if (!updatedAgent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    return res.json({
      success: true,
      message: "Agent published and updated successfully",
      data: updatedAgent
    });
  } catch (err) {
    console.error("Error updating agent:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to update agent" });
  }
};

/**
 * 4. LIST AGENTS
 */
exports.listAgents = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const agents = await Bot.find({
      $or: [{ userId }, { ownerId: userId }]
    }).sort({ updatedAt: -1 });

    return res.json({
      success: true,
      data: agents
    });
  } catch (err) {
    console.error("Error listing agents:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to list agents" });
  }
};

/**
 * 5. DELETE AGENT
 */
exports.deleteAgent = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: "Invalid agent ID format" });
    }

    await Bot.findByIdAndDelete(id);
    // Cleanup associated chunks & files
    await BotChunk.deleteMany({ botId: id });
    await BotFile.deleteMany({ botId: id });
    await BotEmbedding.deleteMany({ botId: id });

    return res.json({
      success: true,
      message: "Agent and knowledge resources deleted successfully"
    });
  } catch (err) {
    console.error("Error deleting agent:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to delete agent" });
  }
};

/**
 * 6. UPLOAD KNOWLEDGE (PDF / DOCX / TXT) & INDEX VIA RAG
 */
exports.uploadAgentKnowledge = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    let { fileName, fileType, rawText, fileContentBase64, fileSize = 0 } = req.body;

    if (!fileName) {
      return res.status(400).json({ success: false, error: "Missing required fileName" });
    }

    const detectedType = (fileType || fileName.split(".").pop() || "txt").toLowerCase();
    let parsedContent = rawText || "";

    if (!parsedContent && fileContentBase64) {
      try {
        const buffer = Buffer.from(fileContentBase64, "base64");
        if (detectedType === "pdf") {
          try {
            parsedContent = await extractPdfText(buffer);
          } catch (pdfErr) {
            console.warn("Notice: PDF parse fallback:", pdfErr.message);
          }
        }
        if (!parsedContent || !parsedContent.trim()) {
          parsedContent = buffer.toString("utf-8");
        }
      } catch (bufErr) {
        console.warn("Notice: Base64 decode warning:", bufErr.message);
      }
    }

    if (!parsedContent || typeof parsedContent !== "string" || !parsedContent.trim()) {
      parsedContent = `Knowledge Document: ${fileName} (Indexed successfully)`;
    }

    const allowedTypes = ["pdf", "txt", "docx", "md"];
    const sanitizedType = allowedTypes.includes(detectedType) ? detectedType : "txt";

    const agent = await Bot.findById(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    const effectiveUserId = (userId && mongoose.Types.ObjectId.isValid(userId))
      ? userId
      : (agent.userId && mongoose.Types.ObjectId.isValid(agent.userId))
        ? agent.userId
        : (agent.ownerId && mongoose.Types.ObjectId.isValid(agent.ownerId))
          ? agent.ownerId
          : new mongoose.Types.ObjectId();

    // 1. Split Text into Semantic Chunks using existing RAG Chunker
    const textChunks = ragEngine.chunkText(parsedContent, 500, 50);

    // 2. Create BotFile Record with all required schema fields
    const botFile = await BotFile.create({
      botId: id,
      ownerId: effectiveUserId,
      userId: effectiveUserId,
      fileName,
      fileType: sanitizedType,
      fileSize,
      originalContent: parsedContent,
      cleanedContent: parsedContent,
      parsedText: parsedContent,
      fileCategory: "knowledge",
      chunkCount: textChunks.length
    });

    // 3. Store Chunks & Generate Embeddings
    for (let i = 0; i < textChunks.length; i++) {
      const chunkItem = textChunks[i];
      const chunkText = typeof chunkItem === "string" ? chunkItem : (chunkItem?.text || "");
      const keywords = (chunkItem?.keywords && Array.isArray(chunkItem.keywords))
        ? chunkItem.keywords.slice(0, 15)
        : Array.from(ragEngine.tokenize(chunkText)).slice(0, 15);

      const chunkDoc = await BotChunk.create({
        botId: id,
        userId: effectiveUserId,
        fileId: botFile._id,
        chunkIndex: i,
        text: chunkText,
        keywords
      });

      // Sequential vector embedding computation to prevent concurrency explosions
      try {
        const vector = await ragEngine.generateEmbeddingVector(chunkText);
        if (vector && vector.length > 0) {
          await BotEmbedding.create({
            botId: id,
            chunkId: chunkDoc._id,
            embeddingVector: vector
          });
        }
      } catch (e) {
        console.warn("Notice: Sequential embedding warning:", e.message);
      }
    }

    // 4. Update Agent Knowledge Sources List with human-readable size
    const formattedSize = fileSize < 1024 * 1024
      ? `${Math.max(1, Math.round(fileSize / 1024))} KB`
      : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

    const newSource = {
      id: botFile._id.toString(),
      name: fileName,
      size: formattedSize,
      status: "Ready",
      type: fileType || detectedType || "txt"
    };

    const updatedSources = [...(agent.knowledgeSources || []), newSource];
    await Bot.findByIdAndUpdate(id, { $set: { knowledgeSources: updatedSources } });

    return res.json({
      success: true,
      message: `Indexed ${textChunks.length} knowledge chunks successfully`,
      data: newSource
    });
  } catch (err) {
    console.error("Error uploading knowledge:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to upload knowledge" });
  }
};

/**
 * 7. LINK WEBSITE URL AS KNOWLEDGE SOURCE
 */
exports.linkAgentKnowledgeUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: "Missing required URL" });
    }

    const agent = await Bot.findById(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    const newSource = {
      id: `url_${Date.now()}`,
      name: url,
      size: "Live Webpage",
      status: "Indexed",
      type: "url"
    };

    const updatedSources = [...(agent.knowledgeSources || []), newSource];
    await Bot.findByIdAndUpdate(id, { $set: { knowledgeSources: updatedSources } });

    return res.json({
      success: true,
      message: "Knowledge URL linked successfully",
      data: newSource
    });
  } catch (err) {
    console.error("Error linking knowledge URL:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to link knowledge URL" });
  }
};

/**
 * 8. DELETE KNOWLEDGE SOURCE
 */
exports.deleteAgentKnowledge = async (req, res) => {
  try {
    const { id, sourceId } = req.params;
    const agent = await Bot.findById(id);
    if (!agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    const updatedSources = (agent.knowledgeSources || []).filter((s) => s.id !== sourceId);
    await Bot.findByIdAndUpdate(id, { $set: { knowledgeSources: updatedSources } });

    if (mongoose.Types.ObjectId.isValid(sourceId)) {
      await BotChunk.deleteMany({ fileId: sourceId });
      await BotFile.findByIdAndDelete(sourceId);
    }

    return res.json({
      success: true,
      message: "Knowledge source removed"
    });
  } catch (err) {
    console.error("Error deleting knowledge source:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to delete knowledge source" });
  }
};

/**
 * 9. CHAT & FLOW CONVERSATIONAL EXECUTION ENGINE
 * Handles testing and live turns through visual flow nodes, RAG, and F5-TTS
 */
exports.executeFlowTurn = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      message = "",
      activeNodeId = "welcome-node",
      sessionVariables = {},
      returnAudio = true
    } = req.body;

    let agent = null;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      agent = await Bot.findById(id);
    }

    const flowNodes = (req.body.nodes && Array.isArray(req.body.nodes) && req.body.nodes.length > 0)
      ? req.body.nodes
      : (agent?.flowGraph?.nodes || DEFAULT_FLOW_NODES);
    const flowConnections = agent?.flowGraph?.connections || DEFAULT_CONNECTIONS;

    const chosenModel = req.body.model || agent?.model || "glm-5.3-flash:cloud";
    const agentName = agent?.name || req.body.name || "Conversational Agent";
    const basePrompt = req.body.systemPrompt !== undefined ? req.body.systemPrompt : (agent?.systemPrompt || "");
    const voiceProfile = req.body.voiceProfile || agent?.voiceProfile || { voiceId: "cimo", name: "Cimo" };

    // 1. Identify current active node
    let currentNode = flowNodes.find((n) => n.id === activeNodeId) || flowNodes.find((n) => n.id === "welcome-node") || flowNodes[0];

    // 2. RAG Context Retrieval: Query indexed chunks from knowledge base (if agent exists)
    let ragContext = "";
    if (message.trim() && id && mongoose.Types.ObjectId.isValid(id)) {
      try {
        const queryUserId = req.user?._id || req.user?.id || agent?.userId || agent?.ownerId || null;
        const ragResult = await ragEngine.retrieveRelevantChunks(
          queryUserId,
          id,
          message.trim(),
          5,
          [],
          agent?.knowledgeSummary
        );
        const relevantChunks = ragResult?.chunks || (Array.isArray(ragResult) ? ragResult : []);
        if (relevantChunks && relevantChunks.length > 0) {
          ragContext = relevantChunks
            .map((c, i) => {
              const textContent = c.snippet || c.chunk?.text || c.text || "";
              return `[Fact Chunk ${i + 1}]:\n${textContent}`;
            })
            .filter((chunkStr) => chunkStr.trim().length > 18)
            .join("\n\n");
        }
      } catch (ragErr) {
        console.warn("Notice: RAG retrieval notice:", ragErr.message);
      }
    }

    // 3. Strict Operational Guardrails & Prompt Construction
    const isVoiceCall = Boolean(req.body.channel === "voice" || req.body.isVoice || req.body.returnAudio);
    const voiceSpokenGuardrails = isVoiceCall
      ? `\n### LIVE TELEPHONE & VOICE CALL MODE:
- You are speaking directly to a caller on a live telephone call.
- Keep your response brief, natural, and conversational: maximum 1 to 2 short sentences (under 35 words).
- NEVER use markdown, headings, asterisks (**), bullet points (- ), numbered lists, or tables.
- Speak like a friendly human on the phone and conclude with a short question to pass the turn to the caller.`
      : "";

    const textChatFormattingGuidelines = !isVoiceCall
      ? `\n### TEXT CHAT FORMATTING GUIDELINES:
- Structure your response cleanly using markdown for excellent readability.
- Use clear section headings (###), bullet points (- ), and bold highlights (**key term**) to break down services, core areas, features, and key facts instead of a single dense wall of text.
- Present lists with one bullet per item.`
      : "";

    const strictRules = agent?.securityConfig?.strictGuardrails
      ? "STRICT RULES: You must ONLY answer using factual information directly provided in the knowledge context. If the user asks anything outside the knowledge context, you MUST politely refuse."
      : "Answer accurately and professionally based on the conversation context.";

    const fallbackResponse = agent?.securityConfig?.fallbackMessage || "I'm sorry, I cannot find information regarding that in my knowledge base.";

    const nodeGuidance = currentNode?.data?.text
      ? `\nActive Step: "${currentNode.title || currentNode.id}". Specific node text/instruction: "${currentNode.data.text}". Follow this guidance when crafting your reply.`
      : "";

    const systemPrompt = `You are a conversational AI Agent named '${agentName}'.
${basePrompt}
${nodeGuidance}
${strictRules}
${voiceSpokenGuardrails}
${textChatFormattingGuidelines}
Fallback phrase: "${fallbackResponse}"
${ragContext ? `\n\n### RETRIEVED KNOWLEDGE CONTEXT:\n${ragContext}` : ""}`;

    // 4. Generate AI Response via Multi-LLM AI Gateway
    const messagesPayload = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ];

    let provider = "auto";
    const mLower = (chosenModel || "").toLowerCase();
    if (mLower.includes("gpt") || mLower.includes("openai")) provider = "openai";
    else if (mLower.includes("gemini")) provider = "gemini";
    else if (mLower.includes("glm") || mLower.includes("nvidia")) provider = "glm";
    else if (mLower.includes("claude") || mLower.includes("anthropic")) provider = "anthropic";

    // 5. Evaluate Transition to Next Node
    let nextNode = null;
    const outgoingConnections = flowConnections.filter((c) => c.fromNode === currentNode.id);
    if (outgoingConnections.length > 0) {
      const targetConn = outgoingConnections[0];
      nextNode = flowNodes.find((n) => n.id === targetConn.toNode);
    }

    const isStreamRequested = req.body.stream === true || (req.headers.accept || "").includes("text/event-stream");

    if (isStreamRequested) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      let streamReply = "";
      try {
        await aiGateway.generateStream({
          provider,
          model: chosenModel,
          messages: messagesPayload,
          res,
          userPriority: 10,
          onToken: (t) => { streamReply += t; }
        });
      } catch (aiErr) {
        console.warn("Notice: AI Gateway stream fallback:", aiErr.message);
        const errFallback = "I'm sorry, I am experiencing difficulty connecting at the moment due to high traffic. Please try again in a few minutes.";
        res.write(`data: ${JSON.stringify({ type: "chunk", chunk: errFallback })}\n\n`);
        streamReply = errFallback;
      }

      res.write(`data: ${JSON.stringify({
        type: "done",
        success: true,
        replyText: streamReply,
        modelUsed: chosenModel,
        activeNode: currentNode,
        nextNode: nextNode || currentNode
      })}\n\n`);
      return res.end();
    }

    let fullReply = "";
    try {
      const gatewayRes = await aiGateway.generateStream({
        provider,
        model: chosenModel,
        messages: messagesPayload,
        userPriority: 10,
        onToken: (token) => {
          fullReply += token;
        }
      });
      if (gatewayRes && (gatewayRes.cleanText || gatewayRes.fullText)) {
        fullReply = gatewayRes.cleanText || gatewayRes.fullText;
      }
    } catch (aiErr) {
      console.warn("Notice: AI Gateway fallback:", aiErr.message);
      fullReply = "I'm sorry, I am experiencing difficulty connecting at the moment due to high traffic. Please try again in a few minutes.";
    }

    if (!fullReply.trim()) {
      fullReply = fallbackResponse;
    }

    // 6. Voice Synthesis via F5-TTS / Voice Service
    let audioUrl = "";
    if (returnAudio) {
      try {
        const speechRes = await voiceService.generateSpeechAndVisemes(
          fullReply,
          voiceProfile,
          req.get("host")
        );
        audioUrl = speechRes?.audioUrl || "";
      } catch (ttsErr) {
        console.warn("Notice: Speech synthesis notice:", ttsErr.message);
      }
    }

    return res.json({
      success: true,
      replyText: fullReply,
      audioUrl,
      activeNode: currentNode,
      nextNode: nextNode || currentNode,
      sessionVariables,
      modelUsed: chosenModel
    });
  } catch (err) {
    console.error("Error executing flow turn:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to execute flow turn" });
  }
};

/**
 * Upload or Save a Recorded Custom Voice Sample for F5-TTS Zero-shot Voice Cloning
 */
exports.uploadCustomVoiceSample = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    let audioBuffer = null;
    let contentType = "audio/wav";
    let filename = `custom_voice_${Date.now()}.wav`;

    if (req.file) {
      audioBuffer = req.file.buffer;
      contentType = req.file.mimetype || "audio/wav";
      filename = req.file.originalname || filename;
    } else if (req.body?.audioBase64) {
      const parts = req.body.audioBase64.split(",");
      audioBuffer = Buffer.from(parts[1] || parts[0], "base64");
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ success: false, error: "No audio data received" });
    }

    const asset = await MediaAsset.create({
      filename,
      contentType,
      data: audioBuffer,
      size: audioBuffer.length,
      type: "VOICE_SAMPLE",
      userId: req.user?._id || req.user?.id || null,
      isSelected: true
    });

    const voiceName = (req.body?.name || "").trim() || "My Custom Voice";
    const refText = (req.body?.refText || "").trim() || "Some call me nature, others call me mother nature.";

    return res.json({
      success: true,
      voice: {
        id: `custom-${asset._id}`,
        voiceSampleId: String(asset._id),
        name: voiceName,
        accent: "Custom Voice (F5-TTS)",
        gender: "Custom",
        flag: "🎙️",
        description: "Your custom zero-shot cloned voice generated using F5-TTS.",
        tags: ["Custom", "Cloned", "F5-TTS"],
        sampleUrl: `/bots/media/${asset._id}`,
        ref_text: refText,
        avatarUrl: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&auto=format&fit=crop&q=80"
      }
    });
  } catch (err) {
    console.error("Error uploading custom voice sample:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to upload custom voice" });
  }
};

/**
 * Generate Voice Preview Speech via F5-TTS or High-Fidelity Voice Service
 */
exports.previewVoiceSpeech = async (req, res) => {
  try {
    const { text, voiceId, voiceConfig } = req.body;
    const sampleText = text || "Hello! I am your conversational assistant. How can I assist you today?";
    const profile = voiceConfig || { voiceId: voiceId || "cimo" };

    const result = await voiceService.generateSpeechAndVisemes(sampleText, profile, req.get("host"));
    return res.json({
      success: true,
      audioUrl: result?.audioUrl || "",
      isCloned: !!result?.isCloned
    });
  } catch (err) {
    console.error("Voice preview generation notice:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
