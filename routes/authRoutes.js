const express = require("express");
const router = express.Router();

const {
  googleAuth,
  googleAuthCallback,
} = require("../controllers/authController");

const multer = require("multer");

/**
 * MIME type allowlist for user profile uploads (voice samples, avatar images).
 * Mirrors the allowlist in botRoutes.js — update both if changing types.
 */
const ALLOWED_MIME_TYPES = new Set([
  // Images (profile avatar)
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Audio (voice samples)
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "audio/x-m4a",
  // Fallback
  "application/octet-stream"
]);

function mimeTypeFilter(req, file, cb) {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
    err.message = `File type "${file.mimetype}" is not allowed. Accepted types: images (JPEG, PNG, WebP) and audio (WAV, MP3, OGG, WebM).`;
    cb(err, false);
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: mimeTypeFilter,
  limits: { fileSize: 25 * 1024 * 1024, files: 2, fields: 20 }
});
const uploadFieldsHandler = upload.fields([
  { name: "avatar", maxCount: 1 },
  { name: "voice", maxCount: 1 },
  { name: "audio", maxCount: 1 },
  { name: "audioFile", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "image", maxCount: 1 }
]);
const authController = require("../controllers/authController");

const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

const handleMulterFields = (req, res, next) => {
  const cType = (req.headers["content-type"] || "").toLowerCase();
  if (cType.includes("multipart") || cType.includes("form-data")) {
    uploadFieldsHandler(req, res, (err) => {
      if (err) {
        console.warn("Multer notice:", err.message);
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
      }
      next();
    });
  } else {
    next();
  }
};

router.post("/google", googleAuth);
router.post("/google/callback", googleAuthCallback);

// Protected User Profile & Voice Sample Routes (Strict User Isolation)
router.get("/me", protect, authController.getCurrentUser);
router.get("/profile", protect, authController.getCurrentUser);

// Delete user account (permanent — wipes all data)
router.delete("/account", protect, authController.deleteAccount);

router.post("/voice-sample", protect, handleMulterFields, authController.uploadVoiceSample);
router.post("/avatar", protect, handleMulterFields, authController.uploadVoiceSample);

router.post("/profile-setup", protect, handleMulterFields, authController.updateProfileAssets);
router.put("/profile-setup", protect, handleMulterFields, authController.updateBotName);

// Voice Sample Endpoints (GET / PUT / DELETE)
router.get("/voice-sample", protect, authController.getUserVoiceSamples);
router.get("/voice-samples", protect, authController.getUserVoiceSamples);

router.put("/voice-sample/:sampleId/select", protect, authController.selectUserVoiceSample);
router.put("/voice-samples/:sampleId/select", protect, authController.selectUserVoiceSample);

router.put("/voice-sample/:sampleId", protect, handleMulterFields, authController.updateUserVoiceSample);
router.put("/voice-samples/:sampleId", protect, handleMulterFields, authController.updateUserVoiceSample);

router.delete("/voice-sample/:sampleId", protect, authController.deleteUserVoiceSample);
router.delete("/voice-samples/:sampleId", protect, authController.deleteUserVoiceSample);

// Avatar Image Endpoints
router.get("/avatars", protect, authController.getUserAvatars);
router.get("/avatar", protect, authController.getUserAvatars);
router.put("/avatars/:avatarId/select", protect, authController.selectUserAvatar);
router.put("/avatar/:avatarId/select", protect, authController.selectUserAvatar);
router.delete("/avatars/:avatarId", protect, authController.deleteUserAvatar);
router.delete("/avatar/:avatarId", protect, authController.deleteUserAvatar);

module.exports = router;