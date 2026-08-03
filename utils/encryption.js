const crypto = require("crypto");

// Strictly load encryption master seed from non-committed .env file
const secretSeed = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;

if (!secretSeed) {
  throw new Error("CRITICAL SECURITY ERROR: ENCRYPTION_KEY or JWT_SECRET must be defined in your .env file!");
}

// Derive a secure 32-byte key for AES-256 encryption
const ENCRYPTION_KEY = crypto.scryptSync(secretSeed, "salt_from_env", 32);
const ALGORITHM = "aes-256-cbc";

/**
 * Encrypts plain text string using AES-256-CBC
 */
function encrypt(text) {
  if (!text) return "";
  // If already encrypted in iv:ciphertext format, return as is
  if (text.includes(":") && text.length > 32) return text;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

/**
 * Decrypts AES-256-CBC ciphertext string back to plain text
 */
function decrypt(text) {
  if (!text) return "";
  try {
    const parts = text.split(":");
    if (parts.length !== 2) return text;
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    return text;
  }
}

module.exports = { encrypt, decrypt };
