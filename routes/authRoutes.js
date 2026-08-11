const express = require("express");

const router = express.Router();

const {
  googleAuth,
  googleAuthCallback,
} = require("../controllers/authController");

router.post("/google", googleAuth);
router.post("/google/callback", googleAuthCallback);

module.exports = router;