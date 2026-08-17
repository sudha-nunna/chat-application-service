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

router.post("/google", googleAuth);
router.post("/google/callback", googleAuthCallback);

// Protected User Profile & Voice Sample Routes (Strict User Isolation)
router.get("/me", protect, authController.getCurrentUser);
router.get("/profile", protect, authController.getCurrentUser);

router.post("/voice-sample", protect, upload.any(), authController.uploadVoiceSample);
router.post("/avatar", protect, upload.any(), authController.uploadVoiceSample);

router.post(
  "/profile-setup",
  protect,
  upload.any(),
  authController.updateProfileAssets
);

// Voice Sample Endpoints
router.get("/voice-sample", protect, authController.getUserVoiceSamples);
router.get("/voice-samples", protect, authController.getUserVoiceSamples);
router.put("/voice-sample/:sampleId/select", protect, authController.selectUserVoiceSample);
router.put("/voice-samples/:sampleId/select", protect, authController.selectUserVoiceSample);
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