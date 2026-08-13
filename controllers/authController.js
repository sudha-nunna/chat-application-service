const User = require("../models/User");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

exports.googleAuth = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Google token is required",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.status(400).json({
        success: false,
        message: "Google account email is unavailable",
      });
    }

    const { email, name, picture } = payload;
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: name || email.split("@")[0],
        email,
        password: undefined,
        profilePic: picture || "",
        authType: "google",
      });
    } else {
      const updates = {};
      if (!user.name && name) updates.name = name;
      if (!user.profilePic && picture) updates.profilePic = picture;
      if (!user.authType) updates.authType = "google";

      if (Object.keys(updates).length > 0) {
        user = await User.findByIdAndUpdate(user._id, updates, { new: true });
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
      },
    });
  } catch (error) {
    console.error("GOOGLE AUTH ERROR =>", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Google authentication failed",
      error: error.response?.data || error.message,
    });
  }
};

exports.googleAuthCallback = async (req, res) => {
  try {
    const { code, redirectUri } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Google authorization code is required",
      });
    }

    const response = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri || `${process.env.CLIENT_URL || "http://localhost:5173"}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const idToken = response.data.id_token;
    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: "Google did not return an ID token",
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return res.status(400).json({
        success: false,
        message: "Google account email is unavailable",
      });
    }

    const { email, name, picture } = payload;
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: name || email.split("@")[0],
        email,
        password: undefined,
        profilePic: picture || "",
        authType: "google",
      });
    } else {
      const updates = {};
      if (!user.name && name) updates.name = name;
      if (!user.profilePic && picture) updates.profilePic = picture;
      if (!user.authType) updates.authType = "google";

      if (Object.keys(updates).length > 0) {
        user = await User.findByIdAndUpdate(user._id, updates, { new: true });
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        voiceSampleId: user.voiceSampleId,
        voiceSampleUrl: user.voiceSampleUrl
      },
    });
  } catch (error) {
    console.error("GOOGLE CALLBACK ERROR =>", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Google callback authentication failed",
      error: error.response?.data || error.message,
    });
  }
};

/**
 * Route 1: Save User Voice Profile (Done Once / Onboarding / Settings)
 * Endpoint: POST /auth/voice-sample or POST /api/v1/user/voice-sample
 * Payload: multipart/form-data (audio file) or Base64 JSON
 */
exports.uploadVoiceSample = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    let audioBuffer = null;
    let contentType = "audio/wav";

    if (req.file && req.file.buffer) {
      audioBuffer = req.file.buffer;
      contentType = req.file.mimetype || "audio/wav";
    } else if (req.body?.audio || req.body?.speech) {
      const rawAudio = req.body.audio || req.body.speech;
      if (typeof rawAudio === "string" && rawAudio.startsWith("data:audio")) {
        const parts = rawAudio.split(",");
        audioBuffer = Buffer.from(parts[1], "base64");
      }
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ success: false, error: "Audio file or speech recording is required for voice sample." });
    }

    const fileHash = require("crypto").randomBytes(8).toString("hex");
    const filename = `user_voice_sample_${Date.now()}_${fileHash}.wav`;

    const mediaAsset = await MediaAsset.create({
      filename,
      contentType,
      data: audioBuffer,
      size: audioBuffer.length,
      type: "VOICE_SAMPLE",
      userId: req.user?.id || null,
      isTransient: false
    });

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const relativeUrl = `/bots/media/${mediaAsset._id}`;
    const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

    let userId = req.user?.id;
    if (userId) {
      await User.findByIdAndUpdate(userId, {
        voiceSampleId: mediaAsset._id,
        voiceSampleUrl: fullUrl
      });
    }

    return res.json({
      success: true,
      message: "Voice profile sample saved successfully.",
      voiceSampleId: mediaAsset._id,
      voiceSampleUrl: fullUrl,
      relativeUrl
    });
  } catch (err) {
    console.error("Upload Voice Sample Error:", err);
    return res.status(500).json({ success: false, error: "Failed to save user voice sample.", details: err.message });
  }
};

/**
 * Unified Onboarding / Settings Profile Setup Endpoint
 * Endpoint: POST /auth/profile-setup or POST /auth/setup
 * Accepts: multipart/form-data with fields `avatar` (image file) and/or `audio` (voice recording file)
 * Allows updating Avatar Image, Voice Sample, or Both together in 1 single request!
 */
exports.updateProfileAssets = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const path = require("path");
    const fs = require("fs");
    const crypto = require("crypto");

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const userId = req.user?.id || req.body?.userId;
    const updates = {};

    let avatarFile = req.files?.avatar?.[0] || req.files?.image?.[0] || req.files?.profilePic?.[0] || (req.file?.fieldname === "avatar" || req.file?.fieldname === "image" ? req.file : null);
    let audioFile = req.files?.audio?.[0] || req.files?.voice?.[0] || req.files?.speech?.[0] || (req.file?.fieldname === "audio" || req.file?.fieldname === "voice" ? req.file : null);

    // 1. Process Avatar Image Upload
    if (avatarFile && avatarFile.buffer) {
      const ext = path.extname(avatarFile.originalname) || ".png";
      const filename = `avatar_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
      const uploadDir = path.join(__dirname, "../uploads/avatars");

      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, avatarFile.buffer);

      updates.profilePic = `/uploads/avatars/${filename}`;
    } else if (req.body?.profilePic || req.body?.avatarUrl) {
      updates.profilePic = req.body.profilePic || req.body.avatarUrl;
    }

    // 2. Process User Voice Sample Upload
    let voiceAsset = null;
    let voiceBuffer = audioFile?.buffer;

    if (!voiceBuffer && (req.body?.audio || req.body?.voice || req.body?.speech)) {
      const rawAudio = req.body.audio || req.body.voice || req.body.speech;
      if (typeof rawAudio === "string" && rawAudio.startsWith("data:audio")) {
        const parts = rawAudio.split(",");
        voiceBuffer = Buffer.from(parts[1], "base64");
      }
    }

    if (voiceBuffer && voiceBuffer.length > 0) {
      const fileHash = crypto.randomBytes(8).toString("hex");
      const filename = `user_voice_sample_${Date.now()}_${fileHash}.wav`;

      voiceAsset = await MediaAsset.create({
        filename,
        contentType: audioFile?.mimetype || "audio/wav",
        data: voiceBuffer,
        size: voiceBuffer.length,
        type: "VOICE_SAMPLE",
        userId: userId || null,
        isTransient: false
      });

      const relativeUrl = `/bots/media/${voiceAsset._id}`;
      const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

      updates.voiceSampleId = voiceAsset._id;
      updates.voiceSampleUrl = fullUrl;
    }

    // 3. Update User Document in DB if user is identified
    let updatedUser = null;
    if (userId && Object.keys(updates).length > 0) {
      updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true });
    }

    let statusMessage = "Profile updated successfully.";
    if (updates.profilePic && updates.voiceSampleId) {
      statusMessage = "Avatar image and voice sample updated successfully.";
    } else if (updates.profilePic) {
      statusMessage = "Avatar image updated successfully.";
    } else if (updates.voiceSampleId) {
      statusMessage = "Voice sample updated successfully.";
    }

    return res.json({
      success: true,
      message: statusMessage,
      updatedFields: Object.keys(updates),
      profilePic: updates.profilePic || updatedUser?.profilePic || "",
      voiceSampleId: updates.voiceSampleId || updatedUser?.voiceSampleId || null,
      voiceSampleUrl: updates.voiceSampleUrl || updatedUser?.voiceSampleUrl || "",
      user: updatedUser || { id: userId, ...updates }
    });
  } catch (err) {
    console.error("Profile Setup Error:", err);
    return res.status(500).json({ success: false, error: "Failed to update profile avatar and voice assets.", details: err.message });
  }
};

/**
 * Get all voice samples recorded by current user
 * Endpoint: GET /auth/voice-samples or GET /api/v1/user/voice-samples
 */
exports.getUserVoiceSamples = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const userId = req.user?.id || "65b000000000000000000001";
    const user = await User.findById(userId).catch(() => null);

    const samples = await MediaAsset.find({
      userId,
      type: "VOICE_SAMPLE"
    }).sort({ createdAt: -1 });

    const reqHost = `${req.protocol}://${req.get("host")}`;

    const formattedSamples = samples.map((asset) => {
      const relativeUrl = `/bots/media/${asset._id}`;
      const isSelected = user?.voiceSampleId?.toString() === asset._id.toString();
      return {
        id: asset._id,
        filename: asset.filename,
        audioUrl: `${reqHost.replace(/\/$/, "")}${relativeUrl}`,
        relativeUrl,
        size: asset.size,
        isSelected,
        createdAt: asset.createdAt
      };
    });

    return res.json({
      success: true,
      activeVoiceSampleId: user?.voiceSampleId || null,
      voiceSamples: formattedSamples
    });
  } catch (err) {
    console.error("Get Voice Samples Error:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch user voice samples." });
  }
};

/**
 * Select active voice sample for avatar cloning
 * Endpoint: PUT /auth/voice-samples/:sampleId/select or PUT /api/v1/user/voice-samples/:sampleId/select
 */
exports.selectUserVoiceSample = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const { sampleId } = req.params;
    const userId = req.user?.id || "65b000000000000000000001";

    const asset = await MediaAsset.findById(sampleId);
    if (!asset || asset.type !== "VOICE_SAMPLE") {
      return res.status(404).json({ success: false, error: "Voice sample not found." });
    }

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const relativeUrl = `/bots/media/${asset._id}`;
    const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

    await User.findByIdAndUpdate(userId, {
      voiceSampleId: asset._id,
      voiceSampleUrl: fullUrl
    });

    return res.json({
      success: true,
      message: "Selected active voice sample updated successfully.",
      selectedVoiceSampleId: asset._id,
      voiceSampleUrl: fullUrl
    });
  } catch (err) {
    console.error("Select Voice Sample Error:", err);
    return res.status(500).json({ success: false, error: "Failed to select voice sample." });
  }
};

/**
 * Delete specific voice sample
 * Endpoint: DELETE /auth/voice-samples/:sampleId or DELETE /api/v1/user/voice-samples/:sampleId
 */
exports.deleteUserVoiceSample = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const { sampleId } = req.params;
    const userId = req.user?.id;

    await MediaAsset.findByIdAndDelete(sampleId);

    if (userId) {
      const user = await User.findById(userId);
      if (user?.voiceSampleId?.toString() === sampleId) {
        await User.findByIdAndUpdate(userId, {
          voiceSampleId: null,
          voiceSampleUrl: ""
        });
      }
    }

    return res.json({
      success: true,
      message: "Voice sample deleted successfully."
    });
  } catch (err) {
    console.error("Delete Voice Sample Error:", err);
    return res.status(500).json({ success: false, error: "Failed to delete voice sample." });
  }
};