const mongoose = require("mongoose");
// Import the core Node.js DNS module
const dns = require("node:dns/promises");

const connectDB = async () => {
  try {
    console.log("URI =>", process.env.MONGO_URI);

    // Force Node.js to use Google and Cloudflare DNS servers, 
    // bypassing the Windows network bug
    dns.setServers(["8.8.8.8", "1.1.1.1"]);

    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB Connected");
  } catch (error) {
    console.error("FULL ERROR =>", error);
    process.exit(1);
  }
};

module.exports = connectDB;