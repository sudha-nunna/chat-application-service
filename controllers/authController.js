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
    const SUPER_ADMIN_EMAILS = ["sairamakrishna2@gmail.com", "saiphanindra8520@gmail.com", "nunnasudha03@gmail.com"];
    const isSuperAdmin = email && SUPER_ADMIN_EMAILS.includes(email.toLowerCase().trim());
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: name || email.split("@")[0],
        email,
        password: undefined,
        profilePic: picture || "",
        authType: "google",
        role: isSuperAdmin ? "admin" : "user",
      });
    } else {
      const updates = {};
      if (!user.name && name) updates.name = name;
      if (!user.profilePic && picture) updates.profilePic = picture;
      if (!user.authType) updates.authType = "google";
      if (isSuperAdmin && user.role !== "admin") updates.role = "admin";

      if (Object.keys(updates).length > 0) {
        user = await User.findByIdAndUpdate(user._id, updates, { new: true });
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const isAvatarSetup = Boolean(
      user.avatarImageId ||
      user.avatarUrl ||
      (user.profilePic && !user.profilePic.includes("googleusercontent"))
    );
    const isVoiceSetup = Boolean(user.voiceSampleId || user.voiceSampleUrl);
    const isProfileSetup = Boolean(isAvatarSetup && isVoiceSetup);
    const activeVoiceUrl = user.voiceSampleUrl || "";
    const activeVoiceId = user.voiceSampleId || null;

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        avatarUrl: user.avatarUrl || user.profilePic || "",
        avatarImageId: user.avatarImageId || null,
        botName: user.botName || "",
        plan: user.plan,
        isProfileSetup,
        isAvatarSetup,
        isVoiceSetup,
        hasAvatar: isAvatarSetup,
        hasVoice: isVoiceSetup,
        isAvatarUploaded: isAvatarSetup,
        isVoiceUploaded: isVoiceSetup,
        voiceSampleId: activeVoiceId,
        voiceSampleUrl: activeVoiceUrl
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

    const isAvatarSetup = Boolean(
      user.avatarImageId ||
      user.avatarUrl ||
      (user.profilePic && !user.profilePic.includes("googleusercontent"))
    );
    const isVoiceSetup = Boolean(user.voiceSampleId || user.voiceSampleUrl || user.audioUrl);
    const isProfileSetup = Boolean(isAvatarSetup && isVoiceSetup);
    const activeVoiceUrl = user.voiceSampleUrl || user.audioUrl || user.voiceUrl || "";
    const activeVoiceId = user.voiceSampleId || null;

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        avatarUrl: user.avatarUrl || user.profilePic || "",
        avatarImageId: user.avatarImageId || null,
        botName: user.botName || "",
        plan: user.plan,
        isProfileSetup,
        isAvatarSetup,
        isVoiceSetup,
        hasAvatar: isAvatarSetup,
        hasVoice: isVoiceSetup,
        isAvatarUploaded: isAvatarSetup,
        isVoiceUploaded: isVoiceSetup,
        voiceSampleId: activeVoiceId,
        audioId: activeVoiceId,
        voiceId: activeVoiceId,
        voiceSampleUrl: activeVoiceUrl,
        audioUrl: activeVoiceUrl,
        voiceUrl: activeVoiceUrl,
        audioSampleUrl: activeVoiceUrl
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
    const path = require("path");
    const fs = require("fs");
    const crypto = require("crypto");

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required to update user assets." });
    }

    const filesArray = Array.isArray(req.files) ? req.files : [];
    const filesMap = !Array.isArray(req.files) ? (req.files || {}) : {};

    let audioFile =
      filesMap.audio?.[0] ||
      filesMap.voice?.[0] ||
      filesMap.speech?.[0] ||
      filesMap.audioFile?.[0] ||
      filesArray.find(f => ["audio", "voice", "speech", "audiofile"].includes((f.fieldname || "").toLowerCase()) || (f.mimetype && f.mimetype.startsWith("audio/"))) ||
      (req.file && (["audio", "voice", "speech", "audiofile"].includes((req.file.fieldname || "").toLowerCase()) || (req.file.mimetype && req.file.mimetype.startsWith("audio/"))) ? req.file : null);

    let avatarFile =
      filesMap.avatar?.[0] ||
      filesMap.image?.[0] ||
      filesMap.profilePic?.[0] ||
      filesMap.avatarPic?.[0] ||
      filesMap.photo?.[0] ||
      filesMap.photoFile?.[0] ||
      filesMap.file?.[0] ||
      filesArray.find(f => ["avatar", "image", "profilePic", "avatarPic", "photo", "photofile", "picture", "file"].includes((f.fieldname || "").toLowerCase()) || (f.mimetype && f.mimetype.startsWith("image/"))) ||
      filesArray.find(f => f !== audioFile && !(f.fieldname || "").toLowerCase().includes("audio") && !(f.fieldname || "").toLowerCase().includes("voice")) ||
      (req.file !== audioFile ? req.file : null);

    const userUpdates = {};
    let voiceSampleAsset = null;
    let avatarImageAsset = null;

    // 1. Process Avatar Image Photo File or Base64 Image
    let avatarBuffer = avatarFile?.buffer;
    let avatarContentType = avatarFile?.mimetype || "image/png";

    if (!avatarBuffer && (req.body?.avatar || req.body?.image || req.body?.profilePic)) {
      const rawImg = req.body.avatar || req.body.image || req.body.profilePic;
      if (typeof rawImg === "string" && rawImg.startsWith("data:image")) {
        const parts = rawImg.split(",");
        avatarBuffer = Buffer.from(parts[1], "base64");
        avatarContentType = rawImg.split(";")[0].replace("data:", "") || "image/png";
      }
    }

    if (avatarBuffer && avatarBuffer.length > 0) {
      const imgHash = crypto.randomBytes(6).toString("hex");
      const imgExt = avatarContentType.includes("jpeg") || avatarContentType.includes("jpg") ? ".jpg" : ".png";
      const imgFilename = `avatar_${Date.now()}_${imgHash}${imgExt}`;

      await MediaAsset.updateMany({ userId, type: { $in: ["PROFILE_IMAGE", "AVATAR_IMAGE", "AVATAR"] } }, { isSelected: false });

      avatarImageAsset = await MediaAsset.create({
        filename: imgFilename,
        contentType: avatarContentType,
        data: avatarBuffer,
        size: avatarBuffer.length,
        type: "PROFILE_IMAGE",
        userId,
        isSelected: true,
        isTransient: false
      });

      const relativeAvatarUrl = `/bots/media/${avatarImageAsset._id}`;
      const fullAvatarUrl = `${reqHost.replace(/\/$/, "")}${relativeAvatarUrl}`;

      userUpdates.profilePic = fullAvatarUrl;
      userUpdates.avatarUrl = fullAvatarUrl;
      userUpdates.avatarImageId = avatarImageAsset._id;
    }

    // 2. Process Voice Sample Audio File or Base64 Audio
    let voiceBuffer = audioFile?.buffer;
    let voiceContentType = audioFile?.mimetype || "audio/wav";

    if (!voiceBuffer && (req.body?.audio || req.body?.voice || req.body?.speech)) {
      const rawAudio = req.body.audio || req.body.voice || req.body.speech;
      if (typeof rawAudio === "string" && rawAudio.startsWith("data:audio")) {
        const parts = rawAudio.split(",");
        voiceBuffer = Buffer.from(parts[1], "base64");
        voiceContentType = rawAudio.split(";")[0].replace("data:", "") || "audio/wav";
      }
    }

    if (voiceBuffer && voiceBuffer.length > 0) {
      const fileHash = crypto.randomBytes(8).toString("hex");
      const audioFilename = `user_voice_sample_${Date.now()}_${fileHash}.wav`;

      await MediaAsset.updateMany({ userId, type: "VOICE_SAMPLE" }, { isSelected: false });

      voiceSampleAsset = await MediaAsset.create({
        filename: audioFilename,
        contentType: voiceContentType,
        data: voiceBuffer,
        size: voiceBuffer.length,
        type: "VOICE_SAMPLE",
        userId,
        isSelected: true,
        isTransient: false
      });

      const relativeVoiceUrl = `/bots/media/${voiceSampleAsset._id}`;
      const fullVoiceUrl = `${reqHost.replace(/\/$/, "")}${relativeVoiceUrl}`;

      userUpdates.voiceSampleId = voiceSampleAsset._id;
      userUpdates.voiceSampleUrl = fullVoiceUrl;

      // Instantly invalidate Redis voice cache so 1st chat request uses this new voice sample
      const { redis, delCache } = require("../utils/redisClient");
      if (redis && redis.status === "ready") {
        await delCache(`avatar:voice:${userId}`);
        await delCache(`user:${userId}`);
        await delCache(`user:${userId}:voice_samples`);
        await delCache(`user:${userId}:active_voice_asset_id`);
        const keys = await redis.keys("avatar:tts:*").catch(() => []);
        if (keys.length > 0) {
          await redis.del(keys).catch(() => {});
        }
      }
    }

    // 3. Process Custom Voice Agent Bot Name if provided in body/query (stored as user.botName and bot.name)
    let agentCustomName = (req.body?.botName || req.body?.voiceAgentName || req.body?.agentName || req.body?.name || req.query?.botName || req.query?.name || "").trim();

    if (agentCustomName) {
      userUpdates.botName = agentCustomName;
      try {
        const Bot = require("../models/Bot");
        let bot = await Bot.findOne({ $or: [{ userId }, { ownerId: userId }] }) || await Bot.findOne({ botType: "AVATAR" });
        if (bot) {
          console.log(`🤖 [AUTH PROFILE] Voice Agent Name updated from "${bot.name}" to "${agentCustomName}" for User: ${userId}`);
          bot.name = agentCustomName;
          await bot.save();
        } else {
          console.log(`🤖 [AUTH PROFILE] Voice Agent Bot created with name "${agentCustomName}" for User: ${userId}`);
          await Bot.create({
            name: agentCustomName,
            description: "Default Conversational AI Avatar Assistant",
            botType: "AVATAR",
            responseMode: "HYBRID",
            userId,
            ownerId: userId
          });
        }
      } catch (botErr) {
        console.warn("Notice: Failed to sync voice agent name to Bot model:", botErr.message);
      }
    }

    const currentUser = await User.findById(userId);
    const hasExistingVoice = Boolean(currentUser?.voiceSampleId || currentUser?.voiceSampleUrl || currentUser?.audioUrl);
    const hasExistingAvatar = Boolean(currentUser?.avatarImageId || (currentUser?.profilePic && !currentUser.profilePic.includes("googleusercontent")));

    const hasNewAvatar = Boolean(avatarBuffer && avatarBuffer.length > 0);
    const hasNewVoice = Boolean(voiceBuffer && voiceBuffer.length > 0);

    const finalAvatarAvailable = hasNewAvatar || hasExistingAvatar;
    const finalVoiceAvailable = hasNewVoice || hasExistingVoice;
    const isBothAvailable = Boolean(finalAvatarAvailable && finalVoiceAvailable);

    userUpdates.isProfileSetup = isBothAvailable;

    let updatedUser;
    if (Object.keys(userUpdates).length > 0) {
      updatedUser = await User.findByIdAndUpdate(userId, userUpdates, { new: true }).select("-password");
    } else {
      updatedUser = currentUser;
    }

    if (!hasNewAvatar && !hasNewVoice && Object.keys(userUpdates).length === 0) {
      return res.status(400).json({
        success: false,
        error: "Please provide an avatar photo image, voice sample recording, or both to update your profile."
      });
    }

    const activeVoiceUrl = voiceSampleAsset ? `${reqHost.replace(/\/$/, "")}/bots/media/${voiceSampleAsset._id}` : (updatedUser?.voiceSampleUrl || "");
    const activeVoiceId = voiceSampleAsset?._id || updatedUser?.voiceSampleId || null;
    const activeAvatarUrl = updatedUser?.avatarUrl || updatedUser?.profilePic || "";
    const activeAvatarId = avatarImageAsset?._id || updatedUser?.avatarImageId || null;

    if (!isBothAvailable) {
      return res.json({
        success: true,
        message: !finalAvatarAvailable
          ? "Voice sample saved successfully. An avatar photo image is still required to complete your profile setup."
          : "Avatar photo image saved successfully. A voice sample recording is still required to complete your profile setup.",
        voiceSampleId: activeVoiceId,
        voiceSampleUrl: activeVoiceUrl,
        avatarId: activeAvatarId,
        avatarUrl: activeAvatarUrl,
        relativeUrl: voiceSampleAsset ? `/bots/media/${voiceSampleAsset._id}` : (avatarImageAsset ? `/bots/media/${avatarImageAsset._id}` : ""),
        isProfileSetup: false,
        isAvatarSetup: finalAvatarAvailable,
        isVoiceSetup: finalVoiceAvailable,
        hasAvatar: finalAvatarAvailable,
        hasVoice: finalVoiceAvailable,
        isAvatarUploaded: finalAvatarAvailable,
        isVoiceUploaded: finalVoiceAvailable,
        missingFields: {
          avatarImage: !finalAvatarAvailable,
          voiceSample: !finalVoiceAvailable
        },
        user: {
          ...(updatedUser ? updatedUser.toObject() : {}),
          botName: updatedUser?.botName || agentCustomName || "",
          voiceSampleUrl: activeVoiceUrl,
          voiceSampleId: activeVoiceId,
          avatarId: activeAvatarId,
          avatarUrl: activeAvatarUrl,
          isProfileSetup: false,
          isAvatarSetup: finalAvatarAvailable,
          isVoiceSetup: finalVoiceAvailable,
          hasAvatar: finalAvatarAvailable,
          hasVoice: finalVoiceAvailable,
          isAvatarUploaded: finalAvatarAvailable,
          isVoiceUploaded: finalVoiceAvailable
        }
      });
    }

    let statusMsg = "Initial profile setup completed successfully.";
    if (avatarImageAsset && voiceSampleAsset) {
      statusMsg = "Avatar photo image and voice profile sample updated successfully.";
    } else if (avatarImageAsset) {
      statusMsg = "Avatar photo image updated successfully.";
    } else if (voiceSampleAsset) {
      statusMsg = "Voice profile sample updated successfully.";
    }

    return res.json({
      success: true,
      message: statusMsg,
      voiceSampleId: activeVoiceId,
      voiceSampleUrl: activeVoiceUrl,
      avatarId: activeAvatarId,
      avatarUrl: activeAvatarUrl,
      botName: updatedUser?.botName || agentCustomName || "",
      isProfileSetup: true,
      isAvatarSetup: true,
      isVoiceSetup: true,
      hasAvatar: true,
      hasVoice: true,
      isAvatarUploaded: true,
      isVoiceUploaded: true,
      user: {
        ...(updatedUser ? updatedUser.toObject() : {}),
        botName: updatedUser?.botName || agentCustomName || "",
        voiceSampleUrl: activeVoiceUrl,
        voiceSampleId: activeVoiceId,
        avatarId: activeAvatarId,
        avatarUrl: activeAvatarUrl,
        isProfileSetup: true,
        isAvatarSetup: true,
        isVoiceSetup: true,
        hasAvatar: true,
        hasVoice: true,
        isAvatarUploaded: true,
        isVoiceUploaded: true
      }
    });
  } catch (err) {
    console.error("Upload Assets Error:", err);
    return res.status(500).json({ success: false, error: "Failed to save profile assets.", details: err.message });
  }
};

/**
 * Endpoint: GET /auth/me
 * Retrieves current authenticated user profile details + isProfileSetup state
 */
exports.getCurrentUser = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication token required" });
    }

    const user = await User.findById(userId).select("-password");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const isAvatarSetup = Boolean(
      user.avatarImageId ||
      user.avatarUrl ||
      (user.profilePic && !user.profilePic.includes("googleusercontent"))
    );
    const isVoiceSetup = Boolean(user.voiceSampleId || user.voiceSampleUrl);
    const isProfileSetup = Boolean(isAvatarSetup && isVoiceSetup);

    const activeVoiceUrl = user.voiceSampleUrl || "";
    const activeVoiceId = user.voiceSampleId || null;

    return res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profilePic: user.profilePic,
        avatarUrl: user.avatarUrl || user.profilePic || "",
        avatarImageId: user.avatarImageId || null,
        botName: user.botName || "",
        authType: user.authType,
        plan: user.plan,
        isProfileSetup,
        isAvatarSetup,
        isVoiceSetup,
        hasAvatar: isAvatarSetup,
        hasVoice: isVoiceSetup,
        isAvatarUploaded: isAvatarSetup,
        isVoiceUploaded: isVoiceSetup,
        voiceSampleId: activeVoiceId,
        voiceSampleUrl: activeVoiceUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (err) {
    console.error("GET /auth/me error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch user profile", error: err.message });
  }
};

/**
 * Unified Onboarding / Settings Profile Setup Endpoint
 * Endpoint: POST /auth/profile-setup, POST /auth/voice-sample, POST /auth/avatar
 * Accepts: multipart/form-data with fields `avatar` (image file) and/or `audio` (voice recording file)
 * Enforces BOTH image + voice for initial setup, and flexible single/double updates afterwards!
 */
exports.updateProfileAssets = exports.uploadVoiceSample;

/**
 * Update Voice Agent Bot Name Only
 * Endpoint: PUT /auth/profile-setup or PUT /auth/bot-name
 * Body: { botName } or { name } or { voiceAgentName }
 */
exports.updateBotName = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    let agentCustomName = (req.body?.botName || req.body?.voiceAgentName || req.body?.agentName || req.body?.name || req.query?.botName || req.query?.name || "").trim();

    if (!agentCustomName) {
      return res.status(400).json({ success: false, error: "Please provide a valid botName to update." });
    }

    // 1. Update user.botName on User model
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { botName: agentCustomName },
      { new: true }
    ).select("-password");

    // 2. Update bot.name on Bot model
    const Bot = require("../models/Bot");
    let bot = await Bot.findOne({ $or: [{ userId }, { ownerId: userId }] }) || await Bot.findOne({ botType: "AVATAR" });
    if (bot) {
      bot.name = agentCustomName;
      await bot.save().catch(() => {});
    } else {
      await Bot.create({
        name: agentCustomName,
        description: "Default Conversational AI Avatar Assistant",
        botType: "AVATAR",
        responseMode: "HYBRID",
        userId,
        ownerId: userId
      }).catch(() => {});
    }

    // 3. Clear session cache if any
    const { delCache } = require("../utils/redisClient");
    await delCache(`user:${userId}`).catch(() => {});

    return res.json({
      success: true,
      message: "Voice Agent botName updated successfully.",
      botName: agentCustomName,
      user: updatedUser
    });
  } catch (err) {
    console.error("Update Bot Name Error:", err);
    return res.status(500).json({ success: false, error: "Failed to update bot name.", details: err.message });
  }
};

/**
 * Get all voice samples recorded by current user
 * Endpoint: GET /auth/voice-samples or GET /api/v1/user/voice-samples
 * Also supports query param ?type=avatar to fetch avatars via the same route!
 */
exports.getUserVoiceSamples = async (req, res) => {
  if (req.query?.type === "avatar" || req.query?.type === "image") {
    return exports.getUserAvatars(req, res);
  }
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    const { getCache, setCache } = require("../utils/redisClient");
    const voiceSamplesCacheKey = `user:${userId}:voice_samples`;

    // 1. Redis Cache First (0ms sub-millisecond RAM response!)
    const cachedData = await getCache(voiceSamplesCacheKey);
    if (cachedData && typeof cachedData === "object") {
      return res.json(cachedData);
    }

    const MediaAsset = require("../models/MediaAsset");
    const user = await User.findById(userId).select("voiceSampleId").lean().catch(() => null);

    const samples = await MediaAsset.find({
      userId,
      type: "VOICE_SAMPLE"
    }).sort({ createdAt: -1 }).lean();

    const reqHost = `${req.protocol}://${req.get("host")}`;

    let activeSampleId = user?.voiceSampleId?.toString() || "";
    if (!activeSampleId && samples.length > 0) {
      const selectedSample = samples.find(s => s.isSelected) || samples[0];
      activeSampleId = selectedSample._id.toString();
    }

    const formattedSamples = samples.map((asset) => {
      const relativeUrl = `/bots/media/${asset._id}`;
      const isSelected = activeSampleId === asset._id.toString();
      return {
        id: asset._id,
        filename: asset.filename,
        audioUrl: `${reqHost.replace(/\/$/, "")}${relativeUrl}`,
        relativeUrl,
        size: asset.size || 0,
        isSelected,
        createdAt: asset.createdAt
      };
    });

    const responsePayload = {
      success: true,
      activeVoiceSampleId: activeSampleId || null,
      voiceSamples: formattedSamples
    };

    // Cache in Redis for 60 seconds (Auto-invalidated on any sample upload/update/delete)
    await setCache(voiceSamplesCacheKey, responsePayload, 60);

    return res.json(responsePayload);
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
  return exports.updateUserVoiceSample(req, res);
};

/**
 * Universal Voice Sample Update & Selection Endpoint
 * Handles renaming filename, selecting active voice, and purging Redis cache!
 * Endpoint: PUT /auth/voice-sample/:sampleId or PUT /auth/voice-sample/:sampleId/select
 */
exports.updateUserVoiceSample = async (req, res) => {
  if (req.query?.type === "avatar" || req.query?.type === "image") {
    return exports.selectUserAvatar(req, res);
  }
  try {
    const MediaAsset = require("../models/MediaAsset");
    const sampleId = req.params.sampleId || req.params.id;
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    let asset = await MediaAsset.findOne({ _id: sampleId, userId });
    if (!asset) {
      asset = await MediaAsset.findById(sampleId).catch(() => null);
    }
    if (!asset || asset.type !== "VOICE_SAMPLE") {
      return res.status(404).json({ success: false, error: "Voice sample not found." });
    }

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const newFilename = (req.body?.filename || req.body?.name || req.body?.title || req.query?.filename || "").trim();
    const shouldSelect = req.body?.isSelected === true || req.body?.select === true || (req.path && req.path.includes("/select"));

    // 1. Rename filename if provided
    if (newFilename) {
      const sanitized = newFilename.toLowerCase().endsWith(".wav") ? newFilename : `${newFilename}.wav`;
      asset.filename = sanitized;
    }

    // 2. Set as active selected voice if requested
    if (shouldSelect) {
      await MediaAsset.updateMany({ userId, type: "VOICE_SAMPLE" }, { isSelected: false });
      asset.isSelected = true;
      await User.findByIdAndUpdate(userId, {
        voiceSampleId: asset._id,
        voiceSampleUrl: `${reqHost.replace(/\/$/, "")}/bots/media/${asset._id}`
      });
    }

    await asset.save();

    // 3. Instantly Purge Redis Cache so changes reflect across app in 0ms
    const { redis, delCache } = require("../utils/redisClient");
    if (redis && redis.status === "ready") {
      await delCache(`avatar:voice:${userId}`);
      await delCache(`user:${userId}`);
      await delCache(`user:${userId}:voice_samples`);
      await delCache(`user:${userId}:active_voice_asset_id`);
      const keys = await redis.keys("avatar:tts:*").catch(() => []);
      if (keys.length > 0) {
        await redis.del(keys).catch(() => {});
      }
    }

    return res.json({
      success: true,
      message: shouldSelect && newFilename
        ? "Voice sample renamed and set as active profile voice."
        : (shouldSelect ? "Selected active voice sample updated successfully." : "Voice sample renamed successfully."),
      selectedVoiceSampleId: asset._id,
      voiceSampleUrl: `${reqHost.replace(/\/$/, "")}/bots/media/${asset._id}`,
      sample: {
        id: asset._id,
        filename: asset.filename,
        audioUrl: `${reqHost.replace(/\/$/, "")}/bots/media/${asset._id}`,
        relativeUrl: `/bots/media/${asset._id}`,
        size: asset.size || 0,
        isSelected: Boolean(asset.isSelected),
        createdAt: asset.createdAt
      }
    });
  } catch (err) {
    console.error("Update Voice Sample Error:", err);
    return res.status(500).json({ success: false, error: "Failed to update voice sample.", details: err.message });
  }
};

/**
 * Delete specific voice sample
 * Endpoint: DELETE /auth/voice-samples/:sampleId or DELETE /api/v1/user/voice-samples/:sampleId
 */
exports.deleteUserVoiceSample = async (req, res) => {
  if (req.query?.type === "avatar" || req.query?.type === "image") {
    return exports.deleteUserAvatar(req, res);
  }
  try {
    const MediaAsset = require("../models/MediaAsset");
    const { sampleId } = req.params;
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    const asset = await MediaAsset.findOneAndDelete({ _id: sampleId, userId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Voice sample not found or unauthorized." });
    }

    const user = await User.findById(userId);
    if (user?.voiceSampleId?.toString() === sampleId) {
      await User.findByIdAndUpdate(userId, {
        voiceSampleId: null,
        voiceSampleUrl: ""
      });
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

/**
 * Get all avatar images uploaded by current user
 * Endpoint: GET /auth/avatars, GET /auth/avatar, or GET /auth/voice-sample?type=avatar
 */
exports.getUserAvatars = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }
    const user = await User.findById(userId).catch(() => null);

    const avatars = await MediaAsset.find({
      userId,
      type: { $in: ["PROFILE_IMAGE", "AVATAR_IMAGE", "AVATAR"] }
    }).sort({ createdAt: -1 });

    const reqHost = `${req.protocol}://${req.get("host")}`;

    const formattedAvatars = avatars.map((asset) => {
      const relativeUrl = `/bots/media/${asset._id}`;
      const isSelected = user?.avatarImageId?.toString() === asset._id.toString() || user?.profilePic?.includes(asset._id.toString());
      return {
        id: asset._id,
        filename: asset.filename,
        avatarUrl: `${reqHost.replace(/\/$/, "")}${relativeUrl}`,
        relativeUrl,
        size: asset.size,
        isSelected,
        createdAt: asset.createdAt
      };
    });

    return res.json({
      success: true,
      activeAvatarId: user?.avatarImageId || null,
      avatars: formattedAvatars,
      // Alias key for compatibility with voice samples response structure
      
    });
  } catch (err) {
    console.error("Get Avatars Error:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch user avatars." });
  }
};

/**
 * Select active avatar image for user profile
 * Endpoint: PUT /auth/avatars/:avatarId/select or PUT /auth/avatar/:avatarId/select
 */
exports.selectUserAvatar = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const avatarId = req.params.avatarId || req.params.sampleId;
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    const asset = await MediaAsset.findOne({ _id: avatarId, userId });
    if (!asset || !["PROFILE_IMAGE", "AVATAR_IMAGE", "AVATAR"].includes(asset.type)) {
      return res.status(404).json({ success: false, error: "Avatar image asset not found." });
    }

    const reqHost = `${req.protocol}://${req.get("host")}`;
    const relativeUrl = `/bots/media/${asset._id}`;
    const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

    await MediaAsset.updateMany({ userId, type: { $in: ["PROFILE_IMAGE", "AVATAR_IMAGE", "AVATAR"] } }, { isSelected: false });
    await MediaAsset.findByIdAndUpdate(avatarId, { isSelected: true });

    await User.findByIdAndUpdate(userId, {
      avatarImageId: asset._id,
      avatarUrl: fullUrl,
      profilePic: fullUrl
    });

    return res.json({
      success: true,
      message: "Active profile avatar updated successfully.",
      selectedAvatarId: asset._id,
      avatarUrl: fullUrl
    });
  } catch (err) {
    console.error("Select Avatar Error:", err);
    return res.status(500).json({ success: false, error: "Failed to select avatar image." });
  }
};

/**
 * Delete specific avatar image asset
 * Endpoint: DELETE /auth/avatars/:avatarId or DELETE /auth/avatar/:avatarId
 */
exports.deleteUserAvatar = async (req, res) => {
  try {
    const MediaAsset = require("../models/MediaAsset");
    const avatarId = req.params.avatarId || req.params.sampleId;
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Authentication token required." });
    }

    const asset = await MediaAsset.findOneAndDelete({ _id: avatarId, userId });
    if (!asset) {
      return res.status(404).json({ success: false, error: "Avatar image not found or unauthorized." });
    }

    const user = await User.findById(userId);
    if (user?.avatarImageId?.toString() === avatarId || user?.profilePic?.includes(avatarId)) {
      await User.findByIdAndUpdate(userId, {
        avatarImageId: null,
        avatarUrl: "",
        profilePic: ""
      });
    }

    return res.json({
      success: true,
      message: "Avatar image deleted successfully."
    });
  } catch (err) {
    console.error("Delete Avatar Error:", err);
    return res.status(500).json({ success: false, error: "Failed to delete avatar image." });
  }
};