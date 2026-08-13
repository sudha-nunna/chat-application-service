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

const protect = require("../middleware/auth");

router.post("/google", googleAuth);
router.post("/google/callback", googleAuthCallback);

// JWT Protected User Profile & Voice Sample Routes
router.post("/voice-sample", protect, upload.single("audio"), authController.uploadVoiceSample);
router.post(
  "/profile-setup",
  protect,
  upload.fields([
    { name: "avatar", maxCount: 1 },
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 },
    { name: "voice", maxCount: 1 }
  ]),
  authController.updateProfileAssets
);
router.get("/voice-samples", protect, authController.getUserVoiceSamples);
router.put("/voice-samples/:sampleId/select", protect, authController.selectUserVoiceSample);
router.delete("/voice-samples/:sampleId", protect, authController.deleteUserVoiceSample);

module.exports = router;