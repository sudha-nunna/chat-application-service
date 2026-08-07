const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const SECRET_KEY = process.env.ENCRYPTION_SECRET || "multi_tenant_bot_secret_key_32bytes!!";
const KEY = crypto.scryptSync(SECRET_KEY, "salt", 32);

function encrypt(text) {
  if (!text || typeof text !== "string") return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
}

function decrypt(encryptedData) {
  if (!encryptedData || typeof encryptedData !== "string") return null;
  try {
    const [ivHex, encryptedText] = encryptedData.split(":");
    if (!ivHex || !encryptedText) return encryptedData;
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("Decryption error:", err.message);
    return encryptedData;
  }
}

module.exports = {
  encrypt,
  decrypt
};
