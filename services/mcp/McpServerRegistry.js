const McpServer = require("../../models/McpServer");

class McpServerRegistry {
  async ensureDefaultServers() {
    try {
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
    } catch (err) {
      try {
        const { sendAlert } = require("../notifications/telegramAlertService");
        const { ALERT_TYPES, SEVERITY } = require("../../config/alertTypes");
        sendAlert({
          type: ALERT_TYPES.MCP,
          severity: SEVERITY.ERROR,
          title: "🔌 MCP Server Registry Error",
          message: `Failed to ensure default MCP servers: ${err.message}`
        }).catch(() => {});
      } catch (_) {}
    }
  }

  async getActiveServerByProvider(provider = "slack") {
    await this.ensureDefaultServers();
    return await McpServer.findOne({ provider, enabled: true });
  }
}

module.exports = new McpServerRegistry();
