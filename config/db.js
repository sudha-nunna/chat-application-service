const mongoose = require("mongoose");
const dns = require("dns");

// Set IPv4 first resolution order (fixes Windows dual-stack IPv6 DNS delays)
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  console.log("URI =>", mongoUri);

  try {
    try {
      dns.setServers(["8.8.8.8", "1.1.1.1"]);
    } catch (e) {
      console.warn("Custom DNS setServers warning:", e.message);
    }

    const options = {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      family: 4,
    };

    await mongoose.connect(mongoUri, options);
    console.log("MongoDB Connected");
  } catch (error) {
    console.warn("First connection attempt failed, retrying with system default DNS...", error.message);
    try {
      // Reset DNS servers to system default and retry
      if (dns.setServers) {
        dns.setServers(["127.0.0.1"]); // resets DNS servers on Node
      }
    } catch (e) {}

    try {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 20000 });
      console.log("MongoDB Connected (via Default DNS)");
    } catch (retryError) {
      console.error("MongoDB Connection Error:", retryError.message);
      throw retryError;
    }
  }
};

module.exports = connectDB;