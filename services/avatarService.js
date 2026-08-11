const crypto = require("crypto");
const path = require("path");
const MediaAsset = require("../models/MediaAsset");

const defaultVisemeMap = {
  mouthCenter: { x: 50, y: 68 },
  mouthWidth: 24,
  mouthHeight: 12,
  shapes: {
    rest: { scaleX: 1.0, scaleY: 0.2, open: 0 },
    A: { scaleX: 1.1, scaleY: 1.0, open: 0.9 },
    E: { scaleX: 1.3, scaleY: 0.5, open: 0.5 },
    O: { scaleX: 0.7, scaleY: 1.1, open: 0.8 },
    U: { scaleX: 0.5, scaleY: 0.7, open: 0.6 },
    M: { scaleX: 0.9, scaleY: 0.1, open: 0.0 },
    F: { scaleX: 1.0, scaleY: 0.3, open: 0.2 },
    L: { scaleX: 1.1, scaleY: 0.7, open: 0.6 },
    S: { scaleX: 1.2, scaleY: 0.4, open: 0.3 }
  }
};

/**
 * Handles avatar face photo, video, or 3D GLTF model upload and stores asset in MongoDB MediaAsset collection.
 * @param {object|string} fileObj - Uploaded file object (Multer or base64 payload or URL)
 * @param {string} reqHost - Host origin for static/media file URLs
 * @param {object} options - Optional metadata (botId, userId)
 * @returns {Promise<object>} Avatar configuration metadata
 */
async function processAvatarUpload(fileObj, reqHost = "http://localhost:5000", options = {}) {
  let fileBuffer = null;
  let filename = "";
  let contentType = "image/png";
  let assetType = "AVATAR_IMAGE";
  let isVideo = false;
  let is3DModel = false;

  if (typeof fileObj === "string" && (fileObj.startsWith("http://") || fileObj.startsWith("https://"))) {
    const isGlb = Boolean(fileObj.match(/\.(glb|gltf)(\?.*)?$/i) || fileObj.includes("readyplayer.me"));
    const isVid = Boolean(fileObj.match(/\.(mp4|webm|mov)(\?.*)?$/i));

    return {
      faceImageUrl: (!isGlb && !isVid) ? fileObj : "",
      faceVideoUrl: isVid ? fileObj : "",
      faceModelUrl: isGlb ? fileObj : "",
      avatar3DModel: isGlb ? fileObj : "",
      relativeUrl: fileObj,
      visemeMap: defaultVisemeMap,
      avatarProvider: isGlb ? "THREE_3D" : isVid ? "VIDEO_AVATAR" : "LOCAL_VISEME"
    };
  }

  if (fileObj && fileObj.buffer) {
    fileBuffer = fileObj.buffer;
    const origName = fileObj.originalname || "avatar.png";
    const ext = path.extname(origName).toLowerCase();

    if ([".glb", ".gltf"].includes(ext)) {
      is3DModel = true;
      contentType = ext === ".gltf" ? "model/gltf+json" : "model/gltf-binary";
      assetType = "AVATAR_3D_MODEL";
    } else if ([".mp4", ".webm", ".mov"].includes(ext)) {
      isVideo = true;
      contentType = ext === ".webm" ? "video/webm" : "video/mp4";
      assetType = "AVATAR_VIDEO";
    } else {
      contentType = fileObj.mimetype || "image/png";
      assetType = "AVATAR_IMAGE";
    }

    const fileHash = crypto.randomBytes(8).toString("hex");
    filename = `avatar_${Date.now()}_${fileHash}${ext || ".png"}`;
  } else if (typeof fileObj === "string") {
    if (fileObj.startsWith("data:")) {
      const matches = fileObj.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        contentType = matches[1];
        fileBuffer = Buffer.from(matches[2], "base64");
        
        let ext = ".png";
        if (contentType.includes("gltf") || contentType.includes("octet-stream") || contentType.includes("model")) {
          ext = ".glb";
          is3DModel = true;
          assetType = "AVATAR_3D_MODEL";
        } else if (contentType.includes("video")) {
          ext = ".mp4";
          isVideo = true;
          assetType = "AVATAR_VIDEO";
        } else {
          assetType = "AVATAR_IMAGE";
        }

        const fileHash = crypto.randomBytes(8).toString("hex");
        filename = `avatar_${Date.now()}_${fileHash}${ext}`;
      }
    } else if (fileObj.length > 50) {
      // Raw Base64 string fallback
      fileBuffer = Buffer.from(fileObj, "base64");
      const fileHash = crypto.randomBytes(8).toString("hex");
      filename = `avatar_${Date.now()}_${fileHash}.png`;
      contentType = "image/png";
      assetType = "AVATAR_IMAGE";
    }
  }

  if (!fileBuffer || !filename) {
    throw new Error("Invalid avatar file upload payload.");
  }

  // Save binary asset directly in MongoDB MediaAsset collection
  const mediaAsset = await MediaAsset.create({
    filename,
    contentType,
    data: fileBuffer,
    size: fileBuffer.length,
    type: assetType,
    botId: options.botId || null,
    userId: options.userId || null,
    isTransient: false
  });

  const relativeUrl = `/bots/media/${mediaAsset._id}`;
  const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

  return {
    faceImageUrl: (!is3DModel && !isVideo) ? fullUrl : "",
    faceVideoUrl: isVideo ? fullUrl : "",
    faceModelUrl: is3DModel ? fullUrl : "",
    avatar3DModel: is3DModel ? fullUrl : "",
    relativeUrl,
    assetId: mediaAsset._id,
    visemeMap: defaultVisemeMap,
    avatarProvider: is3DModel ? "THREE_3D" : isVideo ? "VIDEO_AVATAR" : "LOCAL_VISEME"
  };
}

module.exports = {
  processAvatarUpload
};
