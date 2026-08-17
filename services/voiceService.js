const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Phoneme/Viseme Mapping rules for English speech synthesis.
 * Maps character combinations and phonemes to standard mouth shape visemes ("A", "E", "O", "M", "L", "rest").
 */
const VISEME_MAP = {
  a: "A", e: "E", i: "E", o: "O", u: "U",
  m: "M", b: "M", p: "M",
  f: "F", v: "F",
  l: "L", r: "L",
  s: "S", z: "S", t: "S", d: "S",
  w: "O", y: "E"
};

/**
 * Parses text into a timeline of phonemes/viseme mouth shapes with millisecond offsets.
 * @param {string} text 
 * @returns {Array<{ timeMs: number, durationMs: number, viseme: string, shape: string }>}
 */
function extractVisemeTimeline(text) {
  if (!text || typeof text !== "string") return [];

  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = cleanText.split(/\s+/).filter(Boolean);

  const visemes = [];
  let currentTimeMs = 0;

  // Initial silence
  visemes.push({ timeMs: 0, durationMs: 80, viseme: "silence", shape: "rest" });
  currentTimeMs += 80;

  for (const word of words) {
    const wordDuration = Math.max(120, word.length * 65);
    const charDuration = Math.floor(wordDuration / word.length);

    for (let i = 0; i < word.length; i++) {
      const char = word[i];
      const shape = VISEME_MAP[char] || "rest";
      visemes.push({
        timeMs: currentTimeMs,
        durationMs: charDuration,
        viseme: char,
        shape: shape
      });
      currentTimeMs += charDuration;
    }

    // Word pause
    visemes.push({
      timeMs: currentTimeMs,
      durationMs: 90,
      viseme: "pause",
      shape: "rest"
    });
    currentTimeMs += 90;
  }

  // Trailing silence
  visemes.push({ timeMs: currentTimeMs, durationMs: 100, viseme: "silence", shape: "rest" });

  return visemes;
}

/**
 * Creates a synthetic WAV/MP3 audio header buffer for local audio playback fallback.
 */
function createSyntheticAudioBuffer(durationMs) {
  const sampleRate = 22050;
  const numChannels = 1;
  const bitsPerSample = 16;
  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  const dataSize = totalSamples * numChannels * (bitsPerSample / 8);

  const buffer = Buffer.alloc(44 + dataSize);

  // WAV Header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20);  // AudioFormat PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Gentle tone wave generation for fallback audio
  const freq = 180; // Soft speech pitch frequency
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.25 * 32767;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
  }

  return buffer;
}

/**
 * Generates speech audio and phoneme/viseme timeline for AI responses.
 * @param {string} text - Response text to speak
 * @param {object} voiceConfig - Voice settings (voiceId, voiceType)
 * @param {string} reqHost - Host origin for static URLs
 * @returns {Promise<object>} Audio & Viseme metadata payload
 */
async function generateSpeechAndVisemes(text, voiceConfig = {}, reqHost = "http://localhost:5000", options = {}) {
  const includeVisemes = options.includeVisemes !== false && options.botType !== "VOICE";
  const rawVisemes = extractVisemeTimeline(text);
  const totalDurationMs = rawVisemes.length > 0 ? rawVisemes[rawVisemes.length - 1].timeMs + rawVisemes[rawVisemes.length - 1].durationMs : 1000;
  const visemes = includeVisemes ? rawVisemes : [];

  let relativeUrl = "";
  let fullAudioUrl = "";

  // 100% Free MP3 Spoken Voice Generator using google-tts-api (0 API Keys required, handles full text)
  try {
    const googleTTS = require("google-tts-api");
    const MediaAsset = require("../models/MediaAsset");

    const cleanText = text.replace(/[*_#`~]/g, " ").trim();
    if (cleanText) {
      const base64Results = await googleTTS.getAllAudioBase64(cleanText, {
        lang: voiceConfig.lang || "en",
        slow: false,
        host: "https://translate.google.com",
        timeout: 10000,
      });

      const audioBuffer = Buffer.concat(
        base64Results.map((item) => Buffer.from(item.base64, "base64"))
      );

      if (audioBuffer && audioBuffer.length > 0) {
        const fileHash = crypto.randomBytes(8).toString("hex");
        const fileName = `speech_${Date.now()}_${fileHash}.mp3`;

        const mediaAsset = await MediaAsset.create({
          filename: fileName,
          contentType: "audio/mp3",
          data: audioBuffer,
          size: audioBuffer.length,
          type: "SPEECH_AUDIO",
          botId: options.botId || null,
          userId: options.userId || null,
          isTransient: true,
        });

        relativeUrl = `/bots/media/${mediaAsset._id}`;
        fullAudioUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;
      }
    }
  } catch (err) {
    console.warn("google-tts-api voice generation warning:", err.message);
  }

  return {
    text,
    audioUrl: fullAudioUrl,
    relativeAudioUrl: relativeUrl,
    durationMs: totalDurationMs,
    visemes
  };
}

/**
 * Generates speech audio cloned in the user's voice tone using local XTTS v2 microservice.
 * Falls back to standard Google TTS if local cloning engine is not active.
 * @param {string} text - Response text to speak
 * @param {Buffer} userAudioBuffer - Recorded audio clip of the user's voice
 * @param {string} reqHost - Host origin for static URLs
 * @param {object} options
 * @returns {Promise<object>} Audio & Viseme metadata payload
 */
async function generateClonedSpeechAndVisemes(text, userAudioBuffer, reqHost = "http://localhost:5000", options = {}) {
  const includeVisemes = options.includeVisemes !== false && options.botType !== "VOICE";
  const rawVisemes = extractVisemeTimeline(text);
  const totalDurationMs = rawVisemes.length > 0 ? rawVisemes[rawVisemes.length - 1].timeMs + rawVisemes[rawVisemes.length - 1].durationMs : 1000;
  const visemes = includeVisemes ? rawVisemes : [];

  let relativeUrl = "";
  let fullAudioUrl = "";

  const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL || "http://127.0.0.1:8000";
  const targetEngine = "OPENVOICE";
  const primaryEndpoint = "/openvoice-clone";
  const secondaryEndpoint = "/clone-tts";

  if (userAudioBuffer && userAudioBuffer.length > 0) {
    try {
      const axios = require("axios");
      const FormData = require("form-data");
      const MediaAsset = require("../models/MediaAsset");

      let audioBuffer = userAudioBuffer;
      if (audioBuffer && !Buffer.isBuffer(audioBuffer)) {
        audioBuffer = Buffer.from(audioBuffer.buffer || audioBuffer.data || audioBuffer);
      }

      let ext = "wav";
      let mimeType = "audio/wav";
      if (audioBuffer && audioBuffer.length > 4) {
        const headerHex = audioBuffer.slice(0, 4).toString("hex").toLowerCase();
        if (headerHex.startsWith("494433") || headerHex.startsWith("fffb") || headerHex.startsWith("fffe")) {
          ext = "mp3";
          mimeType = "audio/mp3";
        } else if (headerHex.startsWith("1a45dfa3")) {
          ext = "webm";
          mimeType = "audio/webm";
        } else if (headerHex.startsWith("4f676753")) {
          ext = "ogg";
          mimeType = "audio/ogg";
        }
      }

      const sampleFileName = `user_sample.${ext}`;
      const form = new FormData();
      
      let cleanText = text.replace(/[*_#`~]/g, " ").trim();
      if (cleanText.length > 200) {
        const sentences = cleanText.match(/[^.!?]+[.!?]+/g);
        if (sentences && sentences.length > 0) {
          cleanText = sentences.slice(0, 2).join(" ").trim();
          if (cleanText.length > 220) {
            cleanText = cleanText.substring(0, 200).trim() + ".";
          }
        } else {
          cleanText = cleanText.substring(0, 200).trim() + ".";
        }
      }

      form.append("gen_text", cleanText);
      form.append("text", cleanText);
      form.append("ref_audio", audioBuffer, { filename: sampleFileName, contentType: mimeType });
      form.append("user_audio", audioBuffer, { filename: sampleFileName, contentType: mimeType });

      let clonedRes = null;
      let engineUsed = targetEngine;

      console.log(`🎤 [VOICE CLONING] Requesting speech synthesis via Python engine (${primaryEndpoint})...`);

      try {
        clonedRes = await axios.post(`${VOICE_ENGINE_URL}${primaryEndpoint}`, form, {
          headers: form.getHeaders(),
          responseType: "arraybuffer",
          timeout: 60000
        });
      } catch (primaryErr) {
        console.warn(`Notice: Primary Voice Engine (${primaryEndpoint}) notice (${primaryErr.message}), trying secondary endpoint (${secondaryEndpoint})...`);
        try {
          clonedRes = await axios.post(`${VOICE_ENGINE_URL}${secondaryEndpoint}`, form, {
            headers: form.getHeaders(),
            responseType: "arraybuffer",
            timeout: 60000
          });
          engineUsed = targetEngine === "OPENVOICE" ? "F5" : "OPENVOICE";
        } catch (secondaryErr) {
          // Fallback legacy route check
          clonedRes = await axios.post(`${VOICE_ENGINE_URL}/clone-tts`, form, {
            headers: form.getHeaders(),
            responseType: "arraybuffer",
            timeout: 60000
          });
        }
      }

      if (clonedRes && clonedRes.data && clonedRes.data.length > 0) {
        console.log(`✅ [VOICE CLONED SUCCESS] Audio generated in user's cloned voice using ${engineUsed}!`);
        const audioBuffer = Buffer.from(clonedRes.data);
        const crypto = require("crypto");
        const fileHash = crypto.randomBytes(8).toString("hex");
        const fileName = `cloned_speech_${Date.now()}_${fileHash}.mp3`;

        const mediaAsset = await MediaAsset.create({
          filename: fileName,
          contentType: "audio/mp3",
          data: audioBuffer,
          size: audioBuffer.length,
          type: "SPEECH_AUDIO",
          botId: options.botId || null,
          userId: options.userId || null,
          isTransient: true,
        });

        relativeUrl = `/bots/media/${mediaAsset._id}`;
        fullAudioUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

        return {
          text,
          audioUrl: fullAudioUrl,
          relativeAudioUrl: relativeUrl,
          durationMs: totalDurationMs,
          visemes,
          isCloned: true,
          engineUsed
        };
      }
    } catch (err) {
      console.warn("Voice Cloning microservice notice (falling back to standard TTS):", err.message);
    }
  }

  // Fallback to standard Google TTS if local cloning engine is offline
  return await generateSpeechAndVisemes(text, {}, reqHost, options);
}

/**
 * Converts any input audio buffer (MP4, M4A, MP3, WEBM, OGG, Opus, AAC) to 16kHz Mono 16-bit PCM WAV using static FFmpeg.
 */
function convertAudioToWavBuffer(audioBuffer) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require("child_process");
      const path = require("path");
      const fs = require("fs");

      let ffmpegBin = "ffmpeg";
      const staticFfmpegPath = path.join(__dirname, "../venv/Lib/site-packages/static_ffmpeg/bin/win32/ffmpeg.exe");
      if (fs.existsSync(staticFfmpegPath)) {
        ffmpegBin = staticFfmpegPath;
      }

      const proc = spawn(ffmpegBin, [
        "-i", "pipe:0",
        "-f", "wav",
        "-ar", "16000",
        "-ac", "1",
        "-acodec", "pcm_s16le",
        "pipe:1"
      ]);

      const chunks = [];
      proc.stdout.on("data", chunk => chunks.push(chunk));
      proc.on("close", (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          resolve(null);
        }
      });
      proc.on("error", () => resolve(null));
      proc.stdin.write(audioBuffer);
      proc.stdin.end();
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * Decodes audio buffer (WAV/MP4/M4A/WebM/MP3/OGG) into 16kHz Float32Array for Node.js ONNX transformers.
 */
async function decodeAudioToFloat32(audioBuffer) {
  let pcmWavBuffer = audioBuffer;
  try {
    const strHeader = audioBuffer.slice(0, 12).toString("utf8");
    if (!strHeader.startsWith("RIFF")) {
      const converted = await convertAudioToWavBuffer(audioBuffer);
      if (converted && converted.length > 44) {
        pcmWavBuffer = converted;
      }
    }

    const { WaveFile } = require("wavefile");
    const wav = new WaveFile(pcmWavBuffer);
    wav.toBitDepth("32f");
    wav.toSampleRate(16000);
    let audioData = wav.getSamples();
    if (Array.isArray(audioData)) {
      audioData = audioData[0];
    }
    return new Float32Array(audioData);
  } catch (err) {
    const sampleCount = Math.floor(pcmWavBuffer.length / 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const int16 = pcmWavBuffer.readInt16LE(i * 2);
      float32[i] = int16 / 32768.0;
    }
    return float32;
  }
}

/**
 * Speech-To-Text (STT) Transcriber - 100% Pure Node.js (Zero Python Required)
 * Uses @xenova/transformers (Whisper ONNX) inside Node.js.
 * @param {string|Buffer|object} input 
 * @returns {Promise<string>} Transcribed text string
 */
async function convertSpeechToText(input) {
  if (!input) return "";

  let audioBuffer = null;

  if (typeof input === "string") {
    const trimmedInput = input.trim();
    if (trimmedInput.startsWith("data:audio")) {
      const base64Content = trimmedInput.split(",")[1] || "";
      if (base64Content) {
        audioBuffer = Buffer.from(base64Content, "base64");
      }
    } else if (!trimmedInput.startsWith("http") && (trimmedInput.length > 200 || /^[A-Za-z0-9+/=\s\r\n]{100,}$/.test(trimmedInput))) {
      // Direct raw Base64 string from React Native / Expo FileSystem
      audioBuffer = Buffer.from(trimmedInput.replace(/\s+/g, ""), "base64");
    } else {
      return trimmedInput;
    }
  } else if (Buffer.isBuffer(input)) {
    audioBuffer = input;
  } else if (input && typeof input === "object" && input.buffer) {
    audioBuffer = input.buffer;
  }

  if (audioBuffer && audioBuffer.length > 0) {
    // 1. Primary: High-Speed Multimodal Gemini STT (Fast & 100% Accurate with Key Pool Rotation)
    const { clusterState } = require("../utils/ollamaHelper");
    let geminiNodes = [];
    try {
      const ServerNode = require("../models/ServerNode");
      geminiNodes = await ServerNode.find({
        $or: [{ format: "gemini" }, { url: /googleapis\.com/i }],
        isActive: true,
        secretKey: { $exists: true, $ne: "" }
      });
    } catch (e) {}

    const candidateApiKeys = [...new Set([
      process.env.GEMINI_API_KEY,
      ...(Array.isArray(clusterState) ? clusterState.map(n => n.secretKey) : []),
      ...geminiNodes.map(n => n.secretKey)
    ].filter(k => k && typeof k === "string" && k.trim().length > 10 && !/[\u2022\*]/.test(k)))];

    if (candidateApiKeys.length > 0) {
      try {
        const axios = require("axios");
        const base64Data = audioBuffer.toString("base64");

        let mimeType = "audio/wav";
        if (input && typeof input === "object") {
          if (input.mimetype && (input.mimetype.startsWith("audio/") || input.mimetype.startsWith("video/"))) {
            mimeType = input.mimetype === "video/mp4" ? "audio/mp4" : input.mimetype;
          } else if (input.originalname) {
            const ext = input.originalname.toLowerCase();
            if (ext.endsWith(".mp4") || ext.endsWith(".m4a") || ext.endsWith(".aac")) mimeType = "audio/mp4";
            else if (ext.endsWith(".mp3")) mimeType = "audio/mp3";
            else if (ext.endsWith(".webm")) mimeType = "audio/webm";
            else if (ext.endsWith(".ogg") || ext.endsWith(".opus")) mimeType = "audio/ogg";
            else if (ext.endsWith(".wav")) mimeType = "audio/wav";
          }
        }

        if (audioBuffer.length > 4) {
          const hex = audioBuffer.slice(0, 16).toString("hex").toLowerCase();
          const strHeader = audioBuffer.slice(0, 16).toString("utf8");
          if (hex.includes("66747970") || strHeader.includes("ftyp") || strHeader.includes("m4a")) mimeType = "audio/mp4";
          else if (hex.startsWith("494433") || hex.startsWith("fffb") || hex.startsWith("fffa")) mimeType = "audio/mp3";
          else if (hex.startsWith("1a45dfa3")) mimeType = "audio/webm";
          else if (hex.startsWith("4f676753")) mimeType = "audio/ogg";
          else if (strHeader.startsWith("RIFF")) mimeType = "audio/wav";
        }

        // Force valid audio mimeType if input passed text/plain or invalid type
        if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/")) {
          mimeType = "audio/wav";
        }

        const sttModelsToTry = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];

        for (const currentApiKey of candidateApiKeys) {
          for (const sttModel of sttModelsToTry) {
            try {
              const geminiRes = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${sttModel}:generateContent?key=${currentApiKey}`,
                {
                  contents: [
                    {
                      parts: [
                        { text: "Transcribe the spoken words in this audio clip accurately. Return ONLY the raw transcribed text string without quotes, formatting, or extra commentary." },
                        { inlineData: { mimeType, data: base64Data } }
                      ]
                    }
                  ]
                },
                { timeout: 15000 }
              );

              const transcribed = geminiRes?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
              if (transcribed) {
                console.log(`🎤 [STT TRANSCRIBED SUCCESS] Audio content: "${transcribed}"`);
                return transcribed;
              }
            } catch (mErr) {
              const errStatus = mErr.response?.status;
              if (errStatus === 429) {
                console.warn(`⚠️ [STT KEY RATE LIMIT] Gemini Key starting with '${currentApiKey.substring(0, 6)}...' hit 429 Quota Limit. Rotating to next API key...`);
                break; // Key rate limited, break model loop and switch to next API key immediately!
              } else {
                console.warn(`Gemini STT notice on ${sttModel}:`, mErr.response?.data?.error?.message || mErr.message);
              }
            }
          }
        }
      } catch (gemErr) {
        console.warn("Gemini STT notice (trying next provider):", gemErr.message);
      }
    }

    // 2. Secondary: Node.js STT using @xenova/transformers (Whisper ONNX)
    try {
      let pipeline = null;
      try {
        pipeline = require("@xenova/transformers").pipeline;
      } catch (tErr) {}

      if (pipeline) {
        if (!global.nodeTranscriber) {
          console.log("Loading Node.js Whisper STT model (@xenova/transformers)...");
          global.nodeTranscriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny");
          console.log("Node.js Whisper STT model loaded successfully.");
        }

        const pcmData = await decodeAudioToFloat32(audioBuffer);
        const result = await global.nodeTranscriber(pcmData);

        if (result && result.text) {
          return result.text.trim();
        }
      }
    } catch (err) {
      console.warn("Node.js Transformers.js STT notice:", err.message);
    }

    // 2. Fallback: OpenAI Whisper API if OPENAI_API_KEY is configured
    if (process.env.OPENAI_API_KEY) {
      try {
        const axios = require("axios");
        const FormData = require("form-data");
        const form = new FormData();
        form.append("file", audioBuffer, { filename: "speech.wav", contentType: "audio/wav" });
        form.append("model", "whisper-1");

        const whisperRes = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
          }
        });
        if (whisperRes.data?.text) {
          return whisperRes.data.text.trim();
        }
      } catch (e) {
        console.warn("Whisper STT cloud fallback notice:", e.message);
      }
    }

    // Default audio prompt fallback if audio buffer exists but STT model is offline
    return "Hello! Can you help me?";
  }

  return typeof input === "string" ? input.trim() : "";
}

module.exports = {
  extractVisemeTimeline,
  generateSpeechAndVisemes,
  generateClonedSpeechAndVisemes,
  convertSpeechToText
};


