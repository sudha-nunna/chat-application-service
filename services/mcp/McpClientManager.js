const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

class McpClientManager {
  constructor() {
    this.clients = new Map(); // serverId -> Client
  }

  /**
   * Initializes or connects to an MCP Server transport.
   */
  async getOrConnectClient(serverConfig) {
    const key = serverConfig._id ? serverConfig._id.toString() : serverConfig.name;

    if (this.clients.has(key)) {
      return this.clients.get(key);
    }

    let transport;
    if (serverConfig.type === "STDIO") {
      transport = new StdioClientTransport({
        command: serverConfig.command || "npx",
        args: serverConfig.args || ["-y", "@modelcontextprotocol/server-slack"],
        env: { ...process.env, ...serverConfig.env },
      });
    } else if (serverConfig.type === "SSE") {
      transport = new SSEClientTransport(new URL(serverConfig.url));
    } else {
      throw new Error(`Unsupported MCP transport type: ${serverConfig.type}`);
    }

    const client = new Client(
      { name: "chat-application-host", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    await client.connect(transport);
    this.clients.set(key, client);
    return client;
  }

  /**
   * Disconnects a client transport.
   */
  async disconnectClient(serverConfig) {
    const key = serverConfig._id ? serverConfig._id.toString() : serverConfig.name;
    if (this.clients.has(key)) {
      const client = this.clients.get(key);
      try {
        await client.close();
      } catch (err) {
        console.warn(`Error closing MCP client ${key}:`, err.message);
      }
      this.clients.delete(key);
    }
  }
}

// Singleton instance
module.exports = new McpClientManager();
