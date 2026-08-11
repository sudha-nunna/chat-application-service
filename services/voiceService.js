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
 * Speech-To-Text (STT) Transcriber
 * Accepts audio Base64, audio URL, or buffer, and extracts/transcribes the user speech text.
 * @param {string|Buffer|object} input 
 * @returns {Promise<string>} Transcribed text string
 */
async function convertSpeechToText(input) {
  if (!input) return "";

  if (typeof input === "string") {
    // If input is plain text (not base64 audio data URI), return directly
    if (!input.startsWith("data:audio") && !input.startsWith("http") && !/^[A-Za-z0-9+/=]{100,}$/.test(input)) {
      return input.trim();
    }

    // Handle Base64 Data URI or raw Base64 string
    if (input.startsWith("data:audio")) {
      const base64Content = input.split(",")[1] || "";
      if (base64Content) {
        // Fallback: If OpenAI / Whisper API key is configured in env, call Whisper API
        if (process.env.OPENAI_API_KEY) {
          try {
            const axios = require("axios");
            const FormData = require("form-data");
            const audioBuffer = Buffer.from(base64Content, "base64");
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
            console.warn("Whisper STT transcription error:", e.message);
          }
        }
      }
    }
  }

  // File object / Buffer support
  if (input && typeof input === "object" && input.buffer) {
    if (process.env.OPENAI_API_KEY) {
      try {
        const axios = require("axios");
        const FormData = require("form-data");
        const form = new FormData();
        form.append("file", input.buffer, { filename: input.originalname || "speech.wav", contentType: input.mimetype || "audio/wav" });
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
        console.warn("Whisper STT file transcription error:", e.message);
      }
    }
  }

  return typeof input === "string" ? input.trim() : "";
}

module.exports = {
  extractVisemeTimeline,
  generateSpeechAndVisemes,
  convertSpeechToText
};
