const McpAuditLog = require("../../models/McpAuditLog");

class McpAuditLogger {
  async log({ userId, provider, toolName, arguments: args, status, executionTimeMs, error = "", responseSummary = "" }) {
    try {
      await McpAuditLog.create({
        userId,
        provider,
        toolName,
        arguments: args,
        status,
        executionTimeMs,
        error: String(error),
        responseSummary: String(responseSummary).slice(0, 1000),
      });
    } catch (err) {
      console.error("Failed to persist MCP audit log:", err.message);
    }
  }
}

module.exports = new McpAuditLogger();
