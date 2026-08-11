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