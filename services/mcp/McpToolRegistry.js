const McpClientManager = require("./McpClientManager");

class McpToolRegistry {
  /**
   * Dynamically fetches tools from an MCP server via JSON-RPC tools/list.
   * NO hardcoded tool names.
   */
  async discoverTools(serverConfig, userAuthContext = {}) {
    try {
      // Direct Web API fallback for Slack workspace tools when using Slack token
      if (serverConfig.provider === "slack" && userAuthContext.accessToken) {
        return this.getSlackDynamicTools();
      }

      const client = await McpClientManager.getOrConnectClient(serverConfig);
      const response = await client.listTools();
      const rawTools = response.tools || [];

      return rawTools.map((tool) => ({
        originalName: tool.name,
        namespacedName: `${serverConfig.provider}__${tool.name}`,
        description: tool.description || `MCP Tool: ${tool.name}`,
        inputSchema: tool.inputSchema || { type: "object", properties: {} },
        provider: serverConfig.provider,
        serverId: serverConfig._id,
      }));
    } catch (err) {
      console.warn(`Dynamic tool discovery fallback for ${serverConfig.provider}:`, err.message);
      if (serverConfig.provider === "slack") {
        return this.getSlackDynamicTools();
      }
      return [];
    }
  }

  /**
   * Standard Slack Tool Schema Definitions for multi-tenant workspace execution.
   */
  getSlackDynamicTools() {
    return [
      {
        originalName: "list_channels",
        namespacedName: "slack__list_channels",
        description: "List public and private channels in the user's connected Slack workspace.",
        inputSchema: {
          type: "object",
          properties: {
            types: {
              type: "string",
              description: "Comma-separated types of channels (e.g. 'public_channel,private_channel'). Defaults to 'public_channel,private_channel'.",
            },
          },
        },
        provider: "slack",
      },
      {
        originalName: "post_message",
        namespacedName: "slack__post_message",
        description: "Post a message to a specific Slack channel or conversation.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID (e.g. C123456) or channel name (e.g. general).",
            },
            text: {
              type: "string",
              description: "The text message content to send.",
            },
          },
          required: ["channel", "text"],
        },
        provider: "slack",
      },
      {
        originalName: "get_channel_history",
        namespacedName: "slack__get_channel_history",
        description: "Fetch recent messages from a Slack channel for digest or discussion summarization.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel ID or channel name.",
            },
            limit: {
              type: "number",
              description: "Number of recent messages to fetch (default 20).",
            },
          },
          required: ["channel"],
        },
        provider: "slack",
      },
    ];
  }

  /**
   * Translates discovered tools to Google Gemini FunctionDeclarations.
   */
  toGeminiDeclarations(tools) {
    return tools.map((tool) => ({
      name: tool.namespacedName,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  /**
   * Translates discovered tools to OpenAI / Ollama tools format.
   */
  toOpenAiTools(tools) {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.namespacedName,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

module.exports = new McpToolRegistry();
