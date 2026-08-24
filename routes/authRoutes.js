const express = require("express");
const router = express.Router();

const {
  googleAuth,
  googleAuthCallback,
} = require("../controllers/authController");

const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});
const authController = require("../controllers/authController");

const authMiddleware = require("../middleware/auth");
const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

const handleMulterFields = (req, res, next) => {
  const cType = (req.headers["content-type"] || "").toLowerCase();
  if (cType.includes("multipart") || cType.includes("form-data")) {
    upload.any()(req, res, (err) => {
      if (err) console.warn("Multer notice:", err.message);
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