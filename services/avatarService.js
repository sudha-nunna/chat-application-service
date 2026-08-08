const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Handles avatar face photo/video upload and prepares viseme coordinates.
 * @param {object} fileObj - Uploaded file object (Multer or base64 payload)
 * @param {string} reqHost - Host origin for static file URLs
 * @returns {Promise<object>} Avatar configuration metadata
 */
async function processAvatarUpload(fileObj, reqHost = "http://localhost:5000") {
  const uploadDirPath = path.join(__dirname, "../uploads/avatars");
  if (!fs.existsSync(uploadDirPath)) {
    fs.mkdirSync(uploadDirPath, { recursive: true });
  }

  let fileName = "";
  let isVideo = false;

  if (fileObj && fileObj.buffer) {
    const ext = path.extname(fileObj.originalname || ".png") || ".png";
    isVideo = [".mp4", ".webm", ".mov"].includes(ext.toLowerCase());
    const fileHash = crypto.randomBytes(8).toString("hex");
    fileName = `avatar_${Date.now()}_${fileHash}${ext}`;
    await fs.promises.writeFile(path.join(uploadDirPath, fileName), fileObj.buffer);
  } else if (typeof fileObj === "string") {
    if (fileObj.startsWith("data:")) {
      const matches = fileObj.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const mime = matches[1];
        const ext = mime.includes("video") ? ".mp4" : ".png";
        isVideo = ext === ".mp4";
        const fileHash = crypto.randomBytes(8).toString("hex");
        fileName = `avatar_${Date.now()}_${fileHash}${ext}`;
        const buffer = Buffer.from(matches[2], "base64");
        await fs.promises.writeFile(path.join(uploadDirPath, fileName), buffer);
      }
    } else if (fileObj.startsWith("http://") || fileObj.startsWith("https://")) {
      return {
        imageUrl: fileObj,
        videoUrl: "",
        visemeMap: defaultVisemeMap
      };
    } else {
      const fileHash = crypto.randomBytes(8).toString("hex");
      fileName = `avatar_${Date.now()}_${fileHash}.png`;
      const buffer = Buffer.from(fileObj, "base64");
      await fs.promises.writeFile(path.join(uploadDirPath, fileName), buffer);
    }
  }

  if (!fileName) {
    throw new Error("Invalid avatar file upload payload.");
  }

  const relativeUrl = `/uploads/avatars/${fileName}`;
  const fullUrl = `${reqHost.replace(/\/$/, "")}${relativeUrl}`;

  // Default viseme overlay mapping coordinates (normalized percentage offsets)
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

  return {
    faceImageUrl: isVideo ? "" : fullUrl,
    faceVideoUrl: isVideo ? fullUrl : "",
    relativeUrl,
    visemeMap: defaultVisemeMap,
    avatarProvider: "LOCAL_VISEME"
  };
}

module.exports = {
  processAvatarUpload
};
