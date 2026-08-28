const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const ffmpegPath = require("ffmpeg-static");
const { spawn, execSync } = require("child_process");
const wavefile = require("wavefile");

/**
 * Converts any input audio Buffer (WebM, M4A, AAC, MP3, OGG, WAV) into a 16kHz mono 16-bit PCM WAV Buffer.
 */
function convertAudioTo16kPcmWav(inputBuffer) {
  if (!inputBuffer || !Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    return Promise.resolve(inputBuffer);
  }
  const tmpIn = path.join(os.tmpdir(), "audio_in_" + Date.now() + "_" + Math.random().toString(36).substring(7) + ".tmp");
  const tmpOut = path.join(os.tmpdir(), "audio_out_" + Date.now() + "_" + Math.random().toString(36).substring(7) + ".wav");

  try {
    fs.writeFileSync(tmpIn, inputBuffer);
    execSync('"' + ffmpegPath + '" -y -i "' + tmpIn + '" -ar 16000 -ac 1 -c:a pcm_s16le -f wav "' + tmpOut + '"', { stdio: "pipe" });

    if (fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 44) {
      const convertedBuf = fs.readFileSync(tmpOut);
      if (fs.existsSync(tmpIn)) try { fs.unlinkSync(tmpIn); } catch (e) {}
      if (fs.existsSync(tmpOut)) try { fs.unlinkSync(tmpOut); } catch (e) {}
      return Promise.resolve(convertedBuf);
    }
  } catch (err) {
    console.warn("Notice: FFmpeg conversion warning:", err.message);
  } finally {
    if (fs.existsSync(tmpIn)) try { fs.unlinkSync(tmpIn); } catch (e) {}
    if (fs.existsSync(tmpOut)) try { fs.unlinkSync(tmpOut); } catch (e) {}
  }
  return Promise.resolve(inputBuffer);
}

/**
 * Decodes 16kHz WAV Buffer into Float32Array PCM samples for local Whisper STT.
 */
async function decodeAudioToFloat32(audioBuffer) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return new Float32Array(0);
  }
  let pcmWavBuffer = audioBuffer;
  try {
    const converted = await convertAudioTo16kPcmWav(audioBuffer);
    if (converted && converted.length > 44) {
      pcmWavBuffer = converted;
    }
  } catch (e) {}

  try {
    const wav = new wavefile.WaveFile(pcmWavBuffer);
    wav.toSampleRate(16000);
    wav.toBitDepth("32f");
    let samples = wav.getSamples();
    if (Array.isArray(samples)) samples = samples[0];
    return new Float32Array(samples);
  } catch (e) {
    const numSamples = Math.floor(pcmWavBuffer.length / 2);
    const float32 = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const sample = pcmWavBuffer.length >= (i * 2 + 2) ? pcmWavBuffer.readInt16LE(i * 2) : 0;
      float32[i] = sample / 32768.0;
    }
    return float32;
  }
}

/**
 * Helper to generate visemes timeline from text
 */
function extractVisemeTimeline(text) {
  if (!text || typeof text !== "string") return [];
  const words = text.split(/\s+/);
  const visemeShapes = ["rest", "etc", "E", "A", "O", "U", "FF", "TH", "L"];
  let timeMs = 0;
  const timeline = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const durationMs = Math.max(120, word.length * 45);
    const shape = visemeShapes[(i % (visemeShapes.length - 1)) + 1];

    timeline.push({
      timeMs,
      durationMs,
      viseme: shape,
      shape: shape
    });
    timeMs += durationMs + 30;
  }

  timeline.unshift({ timeMs: 0, durationMs: 80, viseme: "silence", shape: "rest" });
  return timeline;
}

/**
 * Text-to-Speech (TTS) & Viseme Timeline Synthesis
 */
async function generateSpeechAndVisemes(text, voiceConfig = {}, reqHost = "", options = {}) {
  const includeVisemes = options.includeVisemes !== false && options.botType !== "VOICE";
  const rawVisemes = extractVisemeTimeline(text);
  const totalDurationMs = rawVisemes.length > 0 ? rawVisemes[rawVisemes.length - 1].timeMs + rawVisemes[rawVisemes.length - 1].durationMs : 1000;
  const visemes = includeVisemes ? rawVisemes : [];

  let relativeUrl = "";
  let fullAudioUrl = "";

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
        const asset = await MediaAsset.create({
          filename: `tts_${Date.now()}.mp3`,
          contentType: "audio/mp3",
          data: audioBuffer,
          type: "SPEECH_AUDIO",
        });

        if (asset && asset._id) {
          relativeUrl = `/bots/media/${asset._id}`;
          fullAudioUrl = reqHost ? `${reqHost.replace(/\/$/, "")}${relativeUrl}` : relativeUrl;
        }
      }
    }
  } catch (ttsErr) {
    console.warn("⚠️ [TTS GENERATION NOTICE]", ttsErr.message);
  }

  return {
    audioUrl: fullAudioUrl || relativeUrl,
    visemes,
    totalDurationMs,
  };
}

/**
 * Cloned Speech & Viseme Synthesis via F5-TTS / External Engine
 */
async function generateClonedSpeechAndVisemes(text, voiceSampleBuffer, reqHost = "", voiceConfig = {}, options = {}) {
  const includeVisemes = options.includeVisemes !== false && options.botType !== "VOICE";
  const rawVisemes = extractVisemeTimeline(text);
  const totalDurationMs = rawVisemes.length > 0 ? rawVisemes[rawVisemes.length - 1].timeMs + rawVisemes[rawVisemes.length - 1].durationMs : 1000;
  const visemes = includeVisemes ? rawVisemes : [];

  const f5Url = process.env.F5_TTS_URL || process.env.VOICE_ENGINE_URL || "http://127.0.0.1:8000";

  const f5ApiKey = process.env.F5_TTS_API_KEY || "f5_secret_key_123";

  try {
    const FormData = require("form-data");
    const MediaAsset = require("../models/MediaAsset");

    // Senior Developer Text Normalization for Fluent, Natural Human Conversational Delivery
    let cleanSpeechText = text
      .replace(/[*#`~_\-\[\]()]/g, "")
      .replace(/\s*\n\s*/g, ", ")
      .replace(/\s*;\s*/g, ", ")
      .replace(/\s*--\s*/g, ", ")
      .replace(/\.{2,}/g, ".")
      .replace(/([.?!])\s*/g, "$1 ")
      .replace(/\s+/g, " ")
      .trim();

    // Pre-convert reference voice sample to 24kHz mono WAV so F5-TTS gets a clean, format-correct reference
    // Raw MongoDB buffers can be WebM/AAC/M4A from phone recordings — F5-TTS needs exact 24kHz PCM WAV
    let cleanedVoiceSampleBuffer = voiceSampleBuffer;
    try {
      const tmpRefIn = path.join(os.tmpdir(), `ref_in_${Date.now()}.tmp`);
      const tmpRefOut = path.join(os.tmpdir(), `ref_out_${Date.now()}.wav`);
      fs.writeFileSync(tmpRefIn, voiceSampleBuffer);
      execSync(`"${ffmpegPath}" -y -i "${tmpRefIn}" -ar 24000 -ac 1 -sample_fmt s16 -t 12 "${tmpRefOut}"`, { stdio: 'pipe' });
      if (fs.existsSync(tmpRefOut) && fs.statSync(tmpRefOut).size > 100) {
        cleanedVoiceSampleBuffer = fs.readFileSync(tmpRefOut);
        console.log(`✅ [VOICE SAMPLE PREP] Converted reference voice sample to 24kHz mono WAV (${cleanedVoiceSampleBuffer.length} bytes)`);
      }
      try { fs.unlinkSync(tmpRefIn); } catch(e) {}
      try { fs.unlinkSync(tmpRefOut); } catch(e) {}
    } catch (convErr) {
      console.warn('⚠️ [VOICE SAMPLE PREP] ffmpeg conversion warning (using raw buffer):', convErr.message);
    }

    const form = new FormData();
    form.append("gen_text", cleanSpeechText);
    form.append("text", cleanSpeechText);
    form.append("ref_audio", cleanedVoiceSampleBuffer, { filename: "reference.wav", contentType: "audio/wav" });
    form.append("file", cleanedVoiceSampleBuffer, { filename: "reference.wav", contentType: "audio/wav" });
    form.append("speed", "1.0");

    console.log(`🎤 [VOICE CLONING (F5-TTS)] Requesting speech synthesis via F5-TTS Server (${f5Url}/tts)...`);

    const ttsRes = await axios.post(`${f5Url.replace(/\/$/, "")}/tts`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${f5ApiKey}`,
        "Bypass-Tunnel-Remainder": "true",
        "ngrok-skip-browser-warning": "true",
        "User-Agent": "Mozilla/5.0"
      },
      responseType: "arraybuffer",
      timeout: 45000
    });

    const audioBuffer = Buffer.from(ttsRes.data);

    if (audioBuffer && audioBuffer.length > 0) {
      console.log(`✅ [VOICE CLONED SUCCESS] Audio generated in user's cloned voice using F5!`);
      const asset = await MediaAsset.create({
        filename: `f5_cloned_${Date.now()}.wav`,
        contentType: "audio/wav",
        data: audioBuffer,
        type: "SPEECH_AUDIO",
      });

      const relativeUrl = `/bots/media/${asset._id}`;
      const fullAudioUrl = reqHost ? `${reqHost.replace(/\/$/, "")}${relativeUrl}` : relativeUrl;

      return {
        audioUrl: fullAudioUrl,
        visemes,
        totalDurationMs,
        isCloned: true
      };
    }
  } catch (f5Err) {
    const is530 = f5Err.message && (f5Err.message.includes("530") || f5Err.message.includes("502") || f5Err.message.includes("404"));
    if (is530) {
      console.error(`❌ [F5-TTS TUNNEL EXPIRED / OFFLINE (HTTP 530/502)] The Colab Cloudflare Tunnel URL (${f5Url}) is expired or disconnected!`);
      console.error(`👉 ACTION REQUIRED: Update F5_TTS_URL in chat-application-service/.env with your new active Colab trycloudflare.com URL.`);
    } else {
      console.warn("⚠️ [F5-TTS NOTICE] Direct cloning server notice (falling back to standard TTS):", f5Err.message);
    }
  }

  return generateSpeechAndVisemes(text, voiceConfig, reqHost, options);
}

/**
 * High-Speed Speech-to-Text (STT) Service
 * Transcribes audio Buffer / Base64 recording into text string.
 */
async function convertSpeechToText(input) {
  if (!input) return "";

  let rawAudioBuffer = null;

  if (typeof input === "string") {
    const trimmedInput = input.trim();
    if (trimmedInput.startsWith("data:audio")) {
      const base64Content = trimmedInput.split(",")[1] || "";
      if (base64Content) {
        rawAudioBuffer = Buffer.from(base64Content, "base64");
      }
    } else if (!trimmedInput.startsWith("http") && (trimmedInput.length > 200 || /^[A-Za-z0-9+/=\s\r\n]{100,}$/.test(trimmedInput))) {
      rawAudioBuffer = Buffer.from(trimmedInput.replace(/\s+/g, ""), "base64");
    } else {
      return trimmedInput;
    }
  } else if (Buffer.isBuffer(input)) {
    rawAudioBuffer = input;
  } else if (input && typeof input === "object" && input.buffer) {
    rawAudioBuffer = input.buffer;
  }

  if (!rawAudioBuffer || rawAudioBuffer.length === 0) return "";

  // Convert any incoming mobile audio format (WebM, AAC, M4A, MP3, WAV) into standard 16kHz PCM WAV
  const audioBuffer = await convertAudioTo16kPcmWav(rawAudioBuffer);

  // NOTE: @xenova/transformers local Whisper ONNX removed — consumed ~570MB RAM, crashing Render Free Tier.
  // FE sends Browser Native STT text directly. Backend STT is only a last-resort fallback for raw audio uploads.

  // 1. Fallback: Local Whisper Python Microservice (lightweight)
  try {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", audioBuffer, { filename: "speech.wav", contentType: "audio/wav" });

    const VOICE_ENGINE_URL = process.env.VOICE_ENGINE_URL || "http://127.0.0.1:8000";
    const localSttRes = await axios.post(`${VOICE_ENGINE_URL}/transcribe`, form, {
      headers: form.getHeaders(),
      timeout: 8000
    });

    if (localSttRes.data && localSttRes.data.success && localSttRes.data.text) {
      console.log(`🎤 [MICROSERVICE STT SUCCESS] Audio content: "${localSttRes.data.text.trim()}"`);
      return localSttRes.data.text.trim();
    }
  } catch (localSttErr) {
    console.warn("Notice: Local Whisper Microservice notice:", localSttErr.message);
  }

  // 2. Cloud OpenAI Whisper API (last resort — only if OpenAI key is configured)
  try {
    const ServerNode = require("../models/ServerNode");
    const openAiNodes = await ServerNode.find({
      $or: [{ format: "openai" }, { url: /openai\.com/i }],
      isActive: true,
      secretKey: { $exists: true, $ne: "" }
    }).catch(() => []);

    const envOpenAiKeys = (process.env.OPENAI_API_KEY || "").split(",").map(k => k.trim());
    const openAiKeys = [...new Set([
      ...envOpenAiKeys,
      ...openAiNodes.map(n => n.secretKey)
    ].filter(k => k && typeof k === "string" && k.trim().length > 10))];

    if (openAiKeys.length > 0) {
      const FormData = require("form-data");
      for (const oKey of openAiKeys) {
        try {
          const form = new FormData();
          form.append("file", audioBuffer, { filename: "audio.wav", contentType: "audio/wav" });
          form.append("model", "whisper-1");

          const whisperRes = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${oKey}` },
            timeout: 15000
          });

          if (whisperRes.data && whisperRes.data.text) {
            console.log(`🎤 [OPENAI WHISPER STT SUCCESS] Audio content: "${whisperRes.data.text.trim()}"`);
            return whisperRes.data.text.trim();
          }
        } catch (wErr) {}
      }
    }
  } catch (oErr) {}

  return "";
}

module.exports = {
  convertAudioTo16kPcmWav,
  decodeAudioToFloat32,
  generateSpeechAndVisemes,
  generateClonedSpeechAndVisemes,
  convertSpeechToText
};
