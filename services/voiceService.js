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

  const audioBuffer = createSyntheticAudioBuffer(totalDurationMs);
  
  // Save audio file to uploads/audio/
  const fileHash = crypto.randomBytes(8).toString("hex");
  const fileName = `speech_${Date.now()}_${fileHash}.wav`;
  const uploadDirPath = path.join(__dirname, "../uploads/audio");

  if (!fs.existsSync(uploadDirPath)) {
    fs.mkdirSync(uploadDirPath, { recursive: true });
  }

  const filePath = path.join(uploadDirPath, fileName);
  await fs.promises.writeFile(filePath, audioBuffer);

  const relativeUrl = `/uploads/audio/${fileName}`;
  const fullAudioUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;
  const audioBase64 = `data:audio/wav;base64,${audioBuffer.toString("base64")}`;

  return {
    text,
    audioUrl: fullAudioUrl,
    relativeAudioUrl: relativeUrl,
    audioBase64,
    durationMs: totalDurationMs,
    visemes
  };
}

module.exports = {
  extractVisemeTimeline,
  generateSpeechAndVisemes
};
