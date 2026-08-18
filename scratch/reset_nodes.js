const mongoose = require("mongoose");
require("dotenv").config();

async function checkAndResetNodes() {
  await mongoose.connect(process.env.MONGO_URI);
  const ServerNode = require("../models/ServerNode");
  const { decrypt } = require("../utils/encryption");

  const nodes = await ServerNode.find({});
  console.log(`Found ${nodes.length} server nodes in MongoDB:`);

  for (const n of nodes) {
    let rawKey = "";
    try {
      rawKey = n.secretKey ? decrypt(n.secretKey) : "";
    } catch(e) {}
    console.log(`- Node: ${n.name} | Status: ${n.status} | Format: ${n.format} | Model: ${n.defaultModel} | Key: ${rawKey.substring(0, 10)}...`);

    n.status = "ACTIVE";
    n.consecutiveFailures = 0;
    n.retryAfter = null;
    n.errorMessage = "";
    await n.save();
  }

  console.log("✅ All server nodes reset to ACTIVE state!");
  await mongoose.disconnect();
}

checkAndResetNodes().catch(console.error);
