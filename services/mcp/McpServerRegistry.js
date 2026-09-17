const McpServer = require("../../models/McpServer");

class McpServerRegistry {
  async ensureDefaultServers() {
    const slackServer = await McpServer.findOne({ provider: "slack" });
    if (!slackServer) {
      await McpServer.create({
        name: "Slack MCP Server",
        provider: "slack",
        type: "STDIO",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-slack"],
        enabled: true,
        hitlPolicy: false,
        status: "ACTIVE",
      });
      console.log("Registered default Slack MCP Server in MongoDB.");
    }
  }

  async getActiveServerByProvider(provider = "slack") {
    await this.ensureDefaultServers();
    return await McpServer.findOne({ provider, enabled: true });
  }
}

module.exports = new McpServerRegistry();
