const mongoose = require("mongoose");
require("dotenv").config();

async function fixLlamaNodes() {
  await mongoose.connect(process.env.MONGO_URI);
  const ServerNode = require("../models/ServerNode");

  const nodes = await ServerNode.find({});
  console.log(`Updating ${nodes.length} server nodes in MongoDB...`);

  for (const n of nodes) {
    // If node name contains 'llama' or URL is Ollama Cloudflare tunnel, set format to 'ollama'
    if (n.name.toLowerCase().includes("llama") || n.url.includes("trycloudflare.com")) {
      n.format = "ollama";
      n.defaultModel = "llama3.2:3b";
    }

    n.status = "ACTIVE";
    n.consecutiveFailures = 0;
    n.retryAfter = null;
    n.errorMessage = "";
    await n.save();
    console.log(`- Node: ${n.name} | Format: ${n.format} | Model: ${n.defaultModel} | Status: ${n.status}`);
  }

  console.log("✅ Fixed LLaMA nodes format to 'ollama'!");
  await mongoose.disconnect();
}

fixLlamaNodes().catch(console.error);
