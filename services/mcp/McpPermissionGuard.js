class McpPermissionGuard {
  /**
   * Verifies if tool execution requires Human-In-The-Loop approval.
   */
  requiresApproval(toolName, args) {
    const highRiskKeywords = ["delete", "remove", "drop", "terminate", "archive"];
    const isHighRisk = highRiskKeywords.some((keyword) => toolName.toLowerCase().includes(keyword));
    return isHighRisk;
  }

  /**
   * Validates tool call parameters.
   */
  validateParams(toolName, args) {
    if (!args || typeof args !== "object") return { valid: false, message: "Invalid payload parameters" };
    return { valid: true };
  }
}

module.exports = new McpPermissionGuard();
