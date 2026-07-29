const express = require("express");

const router = express.Router();

const {
  register,
  login,
  googleAuth,
  googleAuthCallback,
} = require("../controllers/authController");

router.post("/register", register);

router.post("/login", login);

router.post("/google", googleAuth);
router.post("/google/callback", googleAuthCallback);

module.exports = router;