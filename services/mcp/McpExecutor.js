const McpAuthVault = require("./McpAuthVault");
const McpAuditLogger = require("./McpAuditLogger");
const McpPermissionGuard = require("./McpPermissionGuard");

class McpExecutor {
  /**
   * Helper to dynamically resolve channel ID for ANY workspace (including DMs).
   */
  async resolveSlackChannel(channelParam, headers) {
    const listRes = await fetch("https://slack.com/api/conversations.list?types=public_channel,private_channel,mpim,im", {
      headers,
    });
    const listData = await listRes.json();
    if (!listData.ok || !Array.isArray(listData.channels) || listData.channels.length === 0) {
      throw new Error(`No accessible channels or DMs found in this Slack workspace.`);
    }

    const channels = listData.channels.map((c) => ({
      ...c,
      displayName: c.name || (c.is_im ? "Direct Message" : c.is_mpim ? "Group DM" : c.id),
    }));

    // 1. If channelParam is a valid ID
    if (channelParam && (channelParam.startsWith("C") || channelParam.startsWith("G") || channelParam.startsWith("D"))) {
      const match = channels.find((c) => c.id === channelParam);
      return { channelId: channelParam, channelName: match ? match.displayName : channelParam };
    }

    // 2. Match by channel name
    if (channelParam) {
      const cleanName = String(channelParam).replace(/^#/, "").toLowerCase();
      const matched = channels.find((c) => (c.name || "").toLowerCase() === cleanName);
      if (matched) {
        return { channelId: matched.id, channelName: matched.displayName };
      }
    }

    // 3. Dynamic Fallback: Prefer member channels
    const memberChannel = channels.find((c) => c.is_member === true || c.is_im || c.is_mpim);
    if (memberChannel) {
      return { channelId: memberChannel.id, channelName: memberChannel.displayName };
    }

    // 4. Otherwise, pick first available
    const firstChannel = channels[0];
    return { channelId: firstChannel.id, channelName: firstChannel.displayName };
  }

  /**
   * Executes a tool invocation dynamically on behalf of an authenticated user.
   */
  async executeTool({ userId, toolName, args }) {
    const startTime = Date.now();
    const provider = toolName.split("__")[0] || "slack";
    const actionName = toolName.includes("__") ? toolName.split("__")[1] : toolName;

    // 1. Permission Check
    const validation = McpPermissionGuard.validateParams(toolName, args);
    if (!validation.valid) {
      await McpAuditLogger.log({
        userId,
        provider,
        toolName,
        arguments: args,
        status: "BLOCKED",
        executionTimeMs: Date.now() - startTime,
        error: validation.message,
      });
      return { success: false, error: validation.message };
    }

    // 2. Fetch User's OAuth Token
    const authContext = await McpAuthVault.getValidAccessToken(userId, provider);
    if (!authContext || !authContext.accessToken) {
      const errorMsg = `User has not connected their ${provider.toUpperCase()} workspace. Please connect ${provider.toUpperCase()} first.`;
      await McpAuditLogger.log({
        userId,
        provider,
        toolName,
        arguments: args,
        status: "FAILED",
        executionTimeMs: Date.now() - startTime,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }

    // 3. Dispatch Execution
    try {
      let result;
      if (provider === "slack") {
        result = await this.executeSlackAction(actionName, args, authContext.accessToken);
      } else {
        throw new Error(`Provider ${provider} is not configured.`);
      }

      const executionTimeMs = Date.now() - startTime;
      await McpAuditLogger.log({
        userId,
        provider,
        toolName,
        arguments: args,
        status: "SUCCESS",
        executionTimeMs,
        responseSummary: JSON.stringify(result),
      });

      return { success: true, data: result };
    } catch (err) {
      const executionTimeMs = Date.now() - startTime;
      await McpAuditLogger.log({
        userId,
        provider,
        toolName,
        arguments: args,
        status: "FAILED",
        executionTimeMs,
        error: err.message,
      });
      return { success: false, error: err.message };
    }
  }

  /**
   * Executes Slack Web API tool endpoints using user token.
   */
  async executeSlackAction(actionName, args, token) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    };

    if (actionName === "list_channels" || actionName === "conversations.list") {
      const types = args.types || "public_channel,private_channel,mpim,im";
      const response = await fetch(`https://slack.com/api/conversations.list?types=${encodeURIComponent(types)}`, {
        headers,
      });
      const data = await response.json();
      if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
      return {
        channels: (data.channels || []).map((c) => ({
          id: c.id,
          name: c.name || (c.is_im ? "Direct Message" : c.is_mpim ? "Group DM" : c.id),
          is_private: c.is_private || false,
          is_im: c.is_im || false,
          is_mpim: c.is_mpim || false,
          is_member: c.is_member || c.is_im || false,
          num_members: c.num_members || (c.is_im ? 2 : 1),
          topic: c.topic?.value || "",
        })),
      };
    }

    if (actionName === "post_message" || actionName === "chat.postMessage") {
      const textToSend = args.text || args.message || "";
      const targetChannel = args.channel || args.recipient || "Slack channel/DM";
      const formattedSlackText = `${textToSend}\n_Sent using @Codegene AI_`;
      
      const postRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers,
        body: JSON.stringify({
          channel: targetChannel,
          text: formattedSlackText,
        }),
      });
      const postData = await postRes.json();
      if (!postData.ok) {
        throw new Error(`Slack API error: ${postData.error || "Failed to post message"}`);
      }
      return {
        posted: true,
        target: targetChannel,
        messageContent: textToSend,
        ts: postData.ts,
      };
    }

    if (actionName === "get_channel_history" || actionName === "conversations.history") {
      const typesParam = args.isDm ? "im,mpim" : "public_channel,private_channel,im,mpim";
      const listRes = await fetch(`https://slack.com/api/conversations.list?types=${encodeURIComponent(typesParam)}`, { headers });
      const listData = await listRes.json();
      const allChannels = listData.channels || [];

      if (allChannels.length === 0) {
        throw new Error("No accessible channels or DMs found in this Slack workspace.");
      }

      let candidateChannels = [];

      // User requested specific channel / DM
      if (args.channel) {
        const cleanName = String(args.channel).replace(/^#/, "").toLowerCase();
        const matched = allChannels.find((c) => c.id === args.channel || (c.name || "").toLowerCase() === cleanName);
        if (matched) candidateChannels.push(matched);
      }

      // Add remaining channels sorted by member/DM status
      const sortedChannels = allChannels.slice().sort((a, b) => ((b.is_member || b.is_im) ? 1 : 0) - ((a.is_member || a.is_im) ? 1 : 0));
      for (const chan of sortedChannels) {
        if (!candidateChannels.some((c) => c.id === chan.id)) {
          candidateChannels.push(chan);
        }
      }

      const limit = args.limit || 15;
      let historyFound = null;

      for (const chan of candidateChannels) {
        if (!chan.is_im && !chan.is_mpim) {
          try {
            await fetch("https://slack.com/api/conversations.join", {
              method: "POST",
              headers,
              body: JSON.stringify({ channel: chan.id }),
            });
          } catch (e) {}
        }

        const res = await fetch(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(chan.id)}&limit=${limit}`, {
          headers,
        });
        const historyData = await res.json();

        if (historyData.ok && Array.isArray(historyData.messages) && historyData.messages.length > 0) {
          const chanName = chan.name || (chan.is_im ? "Direct Message" : chan.is_mpim ? "Group DM" : chan.id);
          return {
            channelName: chanName,
            isDm: Boolean(chan.is_im || chan.is_mpim),
            messages: historyData.messages.map((m) => ({
              user: m.user || "User",
              text: m.text || "",
              ts: m.ts,
            })),
          };
        }
      }


      const firstChan = candidateChannels[0] || allChannels[0];
      return {
        channelName: firstChan ? (firstChan.name || "workspace") : "workspace",
        isDm: Boolean(firstChan?.is_im || firstChan?.is_mpim),
        messages: [],
      };
    }

    throw new Error(`Unsupported Slack action: ${actionName}`);
  }

  /**
   * Directly posts a message to Slack on behalf of the user.
   * Resolves recipient (channel name, DM user display name, or user ID) dynamically.
   */
  async sendSlackMessage(userId, recipient, messageText) {
    const authContext = await McpAuthVault.getValidAccessToken(userId, "slack");
    if (!authContext || (!authContext.accessToken && !authContext.userAccessToken)) {
      return {
        success: false,
        error: "Slack workspace is not connected. Please connect your Slack account under MCP Host Servers.",
      };
    }

    const token = authContext.userAccessToken || authContext.accessToken;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    };

    let channelId = null;
    let targetDisplayName = recipient || "Slack recipient";

    try {
      // Step 1: List channels & DMs
      const listRes = await fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel,im,mpim&limit=200",
        { headers }
      );
      const listData = await listRes.json();
      const allChannels = (listData.ok && Array.isArray(listData.channels)) ? listData.channels : [];

      // Clean recipient token (strip leading #/@ and trailing dm/channel keywords)
      const cleanRecipient = (recipient || "")
        .replace(/^[#@]/, "")
        .replace(/\b(dm|dms|direct message|channel|chanel|chat)\b/gi, "")
        .trim()
        .toLowerCase();

      // Priority 1: Direct channel match (e.g. social, general, random)
      const directChan = allChannels.find((c) =>
        c.id === recipient ||
        (c.name && c.name.toLowerCase() === cleanRecipient)
      );

      if (directChan) {
        channelId = directChan.id;
        targetDisplayName = directChan.name ? `#${directChan.name}` : directChan.id;
      } else {
        // Priority 2: Search Slack users list for DM recipient (e.g. Nunna Sudha, sudha)
        let usersList = [];
        try {
          const uRes = await fetch("https://slack.com/api/users.list?limit=200", { headers });
          const uData = await uRes.json();
          if (uData.ok && Array.isArray(uData.members)) {
            usersList = uData.members;
          }
        } catch (e) {}

        const targetSearch = cleanRecipient.replace(/\s+/g, "");
        const recipientTokens = cleanRecipient.split(/\s+/).filter(Boolean);

        const matchedUser = usersList.find((u) => {
          if (u.deleted || u.is_bot) return false;
          const rName = (u.real_name || "").toLowerCase();
          const dName = (u.profile?.display_name || "").toLowerCase();
          const uName = (u.name || "").toLowerCase();
          const fName = (u.profile?.first_name || "").toLowerCase();
          const lName = (u.profile?.last_name || "").toLowerCase();

          // Tokenized match (e.g. "sudha" matches "Nunna Sudha")
          const tokenMatch = recipientTokens.length > 0 && recipientTokens.some(
            (tok) => rName.includes(tok) || dName.includes(tok) || uName.includes(tok) || fName.includes(tok) || lName.includes(tok)
          );

          // Continuous string match
          const rNameNoSpace = rName.replace(/\s+/g, "");
          const dNameNoSpace = dName.replace(/\s+/g, "");
          const uNameNoSpace = uName.replace(/\s+/g, "");

          const stringMatch = (
            rNameNoSpace.includes(targetSearch) ||
            dNameNoSpace.includes(targetSearch) ||
            uNameNoSpace.includes(targetSearch) ||
            targetSearch.includes(uNameNoSpace) ||
            (rNameNoSpace.length > 0 && targetSearch.includes(rNameNoSpace))
          );

          return tokenMatch || stringMatch;
        });

        if (matchedUser) {
          targetDisplayName = matchedUser.profile?.display_name || matchedUser.profile?.real_name || matchedUser.real_name || matchedUser.name;
          
          // Open DM conversation with user to guarantee channelId
          const openRes = await fetch("https://slack.com/api/conversations.open", {
            method: "POST",
            headers,
            body: JSON.stringify({ users: matchedUser.id }),
          });
          const openData = await openRes.json();
          if (openData.ok && openData.channel) {
            channelId = openData.channel.id;
          } else {
            const existingIm = allChannels.find((c) => c.is_im && c.user === matchedUser.id);
            if (existingIm) channelId = existingIm.id;
          }
        } else {
          // Check if an IM channel's user info matches cleanRecipient
          for (const c of allChannels) {
            if (c.is_im && c.user) {
              try {
                const uInfoRes = await fetch(`https://slack.com/api/users.info?user=${c.user}`, { headers });
                const uInfoData = await uInfoRes.json();
                if (uInfoData.ok && uInfoData.user) {
                  const uName = (uInfoData.user.profile?.display_name || uInfoData.user.real_name || uInfoData.user.name || "").toLowerCase().replace(/\s+/g, "");
                  if (uName.includes(targetSearch) || targetSearch.includes(uName)) {
                    channelId = c.id;
                    targetDisplayName = uInfoData.user.profile?.display_name || uInfoData.user.real_name || uInfoData.user.name;
                    break;
                  }
                }
              } catch (e) {}
            }
          }
        }
      }

      if (!channelId) {
        let availableMembers = [];
        try {
          const uRes = await fetch("https://slack.com/api/users.list?limit=200", { headers });
          const uData = await uRes.json();
          if (uData.ok && Array.isArray(uData.members)) {
            availableMembers = uData.members
              .filter(u => !u.deleted && !u.is_bot)
              .map(u => u.profile?.real_name || u.real_name || u.name);
          }
        } catch (e) {}

        const membersInfo = availableMembers.length > 0 ? ` Available workspace members: ${availableMembers.join(", ")}.` : "";
        return {
          success: false,
          error: `Could not find any Slack channel or DM user matching "${recipient}".${membersInfo}`,
        };
      }

      // Ensure proper capitalization for display target
      if (targetDisplayName && typeof targetDisplayName === "string" && !targetDisplayName.startsWith("#")) {
        targetDisplayName = targetDisplayName.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      }

      // Step 2: Post message to Slack
      const formattedSlackText = `${messageText}\n_Sent using @Codegene AI_`;

      const postRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers,
        body: JSON.stringify({
          channel: channelId,
          text: formattedSlackText,
        }),
      });

      const postData = await postRes.json();
      if (!postData.ok) {
        return {
          success: false,
          error: `Slack API error: ${postData.error || "Failed to post message"}`,
        };
      }

      return {
        success: true,
        recipientName: targetDisplayName,
        channelId,
        message: messageText,
        ts: postData.ts,
      };
    } catch (err) {
      return {
        success: false,
        error: `Network error posting to Slack: ${err.message}`,
      };
    }
  }
}

module.exports = new McpExecutor();
