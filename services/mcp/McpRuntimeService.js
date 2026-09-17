const McpServerRegistry = require("./McpServerRegistry");
const McpToolRegistry = require("./McpToolRegistry");
const McpToolCache = require("./McpToolCache");
const McpExecutor = require("./McpExecutor");
const McpAuthVault = require("./McpAuthVault");

class McpRuntimeService {
  async getToolsForUser(userId, provider = "slack") {
    const authContext = await McpAuthVault.getValidAccessToken(userId, provider);
    if (!authContext || !authContext.accessToken)
      return { connected: false, tools: [], geminiDeclarations: [], openAiTools: [] };
    const cachedTools = await McpToolCache.getCachedTools(userId, provider);
    let tools = cachedTools;
    if (!tools) {
      const serverConfig = await McpServerRegistry.getActiveServerByProvider(provider);
      if (!serverConfig)
        return { connected: true, tools: [], geminiDeclarations: [], openAiTools: [] };
      tools = await McpToolRegistry.discoverTools(serverConfig, authContext);
      await McpToolCache.setCachedTools(userId, provider, tools);
    }
    return {
      connected: true,
      authContext: { teamName: authContext.teamName, userSlackId: authContext.userSlackId },
      tools,
      geminiDeclarations: McpToolRegistry.toGeminiDeclarations(tools),
      openAiTools: McpToolRegistry.toOpenAiTools(tools),
    };
  }

  async executeToolCall(userId, toolName, args) {
    return await McpExecutor.executeTool({ userId, toolName, args });
  }

  /**
   * Builds a comprehensive real Slack context block for LLM injection.
   *
   * Fixes vs old implementation:
   *  1. Resolves DM contact names BEFORE fetching history (user field on IM channels = other person's ID)
   *  2. Auto-joins public/private channels before reading history (fixes not_in_channel)
   *  3. Returns channel info even on access errors with clear error label in context
   *  4. Prioritises DMs matching person names mentioned in the user query
   *  5. Proper HTML entity decode and newline cleanup in message text
   */
  async buildSlackContext(userId, userQuery) {
    userQuery = userQuery || "";
    const authContext = await McpAuthVault.getValidAccessToken(userId, "slack");
    if (!authContext || !authContext.accessToken) return null;

    const token = authContext.userAccessToken || authContext.accessToken;
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json; charset=utf-8",
    };
    const lowerQuery = userQuery.toLowerCase();
    const isDmQuery = /\b(dm|dms|direct message|direct messages|chat)\b/i.test(lowerQuery);
    const specificChannelMatch = userQuery.match(/#([a-zA-Z0-9_-]+)/);
    const specificChannel = specificChannelMatch ? specificChannelMatch[1] : "";
    const limitMatch = lowerQuery.match(/\b(?:last|recent|top|latest)\s+(\d+)\b/);
    const msgLimit = Math.min(parseInt(limitMatch ? limitMatch[1] : "20", 10), 50);

    // ── Step 0: Fetch bot user identity dynamically ─────────────────────────
    let botUsername = "chat";
    try {
      const authTestRes = await fetch("https://slack.com/api/auth.test", { headers });
      const authTestData = await authTestRes.json();
      if (authTestData.ok && authTestData.user) {
        botUsername = authTestData.user;
      }
    } catch (e) {}

    // ── Step 1: Fetch ALL channels + DMs ─────────────────────────────────────
    let allChannels = [];
    try {
      const listRes = await fetch(
        "https://slack.com/api/conversations.list?types=public_channel,private_channel,im,mpim&limit=200",
        { headers }
      );
      const listData = await listRes.json();
      if (listData.ok && Array.isArray(listData.channels)) {
        allChannels = listData.channels;
        console.log("[MCP] conversations.list: found " + allChannels.length + " channels/DMs");
      } else {
        console.warn("[MCP] conversations.list error: " + (listData.error || "unknown"));
        return null;
      }
    } catch (e) {
      console.warn("[MCP] conversations.list network error:", e.message);
      return null;
    }
    if (allChannels.length === 0) return null;

    // ── Step 2: Pre-resolve ALL DM contact names ──────────────────────────────
    // For IM channels, the 'user' field is the OTHER person's Slack ID.
    // Resolve upfront so DM labels show real names ("slack user"), not IDs.
    const userNameCache = {};
    const selfId = authContext.userSlackId;
    let workspaceMembers = [];

    try {
      const usersRes = await fetch("https://slack.com/api/users.list?limit=200", { headers });
      const usersData = await usersRes.json();
      if (usersData.ok && Array.isArray(usersData.members)) {
        workspaceMembers = usersData.members.filter(function(m) { return !m.deleted && !m.is_bot; });
        workspaceMembers.forEach(function(m) {
          const uName = (m.profile && (m.profile.display_name || m.profile.real_name)) || m.real_name || m.name || m.id;
          userNameCache[m.id] = uName;
        });
        console.log("[MCP] users.list: found " + workspaceMembers.length + " active human workspace members");
      }
    } catch (e) {
      console.warn("[MCP] users.list error:", e.message);
    }

    const dmUserIds = allChannels
      .filter(function(c) { return (c.is_im || c.is_mpim) && c.user; })
      .map(function(c) { return c.user; });
    const idsToResolve = Array.from(new Set(dmUserIds.concat(selfId ? [selfId] : [])));

    await Promise.allSettled(idsToResolve.map(async function(uid) {
      if (userNameCache[uid]) return;
      try {
        const res = await fetch("https://slack.com/api/users.info?user=" + uid, { headers });
        const d = await res.json();
        if (d.ok && d.user) {
          userNameCache[uid] =
            (d.user.profile && (d.user.profile.display_name || d.user.profile.real_name)) ||
            d.user.real_name ||
            d.user.name ||
            uid;
        } else {
          userNameCache[uid] = uid;
        }
      } catch (e) {
        userNameCache[uid] = uid;
      }
    }));

    // Helper: get human-readable label for any channel
    const getDisplayName = function(chan) {
      if ((chan.is_im || chan.is_mpim) && chan.user) {
        return userNameCache[chan.user] || chan.user;
      }
      return chan.name || chan.id;
    };

    // ── Step 3: Prioritise channels to fetch ─────────────────────────────────
    const prioritised = allChannels.slice();
    if (specificChannel) {
      prioritised.sort(function(a, b) {
        const aM = (a.name || "").toLowerCase() === specificChannel.toLowerCase() ? -2 : 0;
        const bM = (b.name || "").toLowerCase() === specificChannel.toLowerCase() ? -2 : 0;
        return aM - bM;
      });
    } else {
      const queryWords = lowerQuery.split(/\s+/).filter(function(w) { return w.length >= 3; });
      let personMatchedId = null;
      for (let i = 0; i < allChannels.length; i++) {
        const c = allChannels[i];
        if (!c.is_im && !c.is_mpim) continue;
        const name = getDisplayName(c).toLowerCase();
        if (queryWords.some(function(w) { return name.includes(w); })) {
          personMatchedId = c.id;
          break;
        }
      }
      prioritised.sort(function(a, b) {
        if (personMatchedId) {
          if (a.id === personMatchedId) return -10;
          if (b.id === personMatchedId) return 10;
        }
        if (isDmQuery) {
          const aD = (a.is_im || a.is_mpim) ? -1 : 0;
          const bD = (b.is_im || b.is_mpim) ? -1 : 0;
          if (aD !== bD) return aD - bD;
        }
        const sc = function(c) { return c.is_member ? -2 : (c.is_im || c.is_mpim) ? -1 : 0; };
        return sc(a) - sc(b);
      });
    }

    const channelsToFetch = prioritised.slice(0, 10);

    // ── Step 4: Fetch history for each channel (with auto-join) ──────────────
    const channelResults = await Promise.allSettled(channelsToFetch.map(async function(chan) {
      const isDm = Boolean(chan.is_im || chan.is_mpim);
      const displayName = getDisplayName(chan);

      // Auto-join public/private channels so the bot can read their history
      if (!isDm) {
        try {
          const joinRes = await fetch("https://slack.com/api/conversations.join", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ channel: chan.id }),
          });
          const jd = await joinRes.json();
          if (jd.ok) {
            console.log("[MCP] Bot joined #" + displayName);
          } else if (jd.error !== "already_in_channel" && jd.error !== "method_not_supported_for_channel_type") {
            console.warn("[MCP] join failed for #" + displayName + ": " + jd.error);
          }
        } catch (e) {}
      }

      // Fetch message history
      const histRes = await fetch(
        "https://slack.com/api/conversations.history?channel=" + encodeURIComponent(chan.id) + "&limit=" + msgLimit,
        { headers: headers }
      );
      const histData = await histRes.json();

      if (!histData.ok) {
        console.warn("[MCP] history failed " + displayName + " (" + chan.id + "): " + histData.error);
        return {
          id: chan.id,
          displayName: displayName,
          isDm: isDm,
          isPrivate: Boolean(chan.is_private),
          messages: [],
          accessError: histData.error || "unknown",
        };
      }

      const messages = Array.isArray(histData.messages) ? histData.messages : [];
      console.log("[MCP] " + displayName + ": " + messages.length + " messages");

      // Resolve sender names for this channel's messages
      const msgUserIds = Array.from(new Set(messages.map(function(m) { return m.user; }).filter(Boolean)));
      await Promise.allSettled(msgUserIds.map(async function(uid) {
        if (userNameCache[uid]) return;
        try {
          const res = await fetch("https://slack.com/api/users.info?user=" + uid, { headers: headers });
          const d = await res.json();
          userNameCache[uid] = (d.ok && d.user)
            ? ((d.user.profile && (d.user.profile.display_name || d.user.profile.real_name)) || d.user.real_name || d.user.name || uid)
            : uid;
        } catch (e) {
          userNameCache[uid] = uid;
        }
      }));

      return {
        id: chan.id,
        displayName: displayName,
        isDm: isDm,
        isPrivate: Boolean(chan.is_private),
        messages: messages,
        accessError: null,
      };
    }));

    const resolvedChannels = channelResults
      .map(function(r) { return r.status === "fulfilled" ? r.value : null; })
      .filter(Boolean);

    if (resolvedChannels.length === 0) return null;

    // ── Step 5: Build rich structured context string ──────────────────────────
    const workspace = authContext.teamName || "Slack Workspace";
    const selfName = selfId ? (userNameCache[selfId] || "You") : "You";
    const totalMessages = resolvedChannels.reduce(function(s, c) { return s + c.messages.length; }, 0);
    const channelsWithErrors = resolvedChannels.filter(function(c) { return c.accessError; });
    const lines = [];

    lines.push("## Slack Workspace: " + workspace);
    lines.push("Connected as: " + selfName);
    lines.push("Total messages retrieved: " + totalMessages);
    lines.push("Total active human members in workspace: " + (workspaceMembers.length > 0 ? workspaceMembers.length : "Unknown"));
    lines.push("");

    if (workspaceMembers.length > 0) {
      lines.push("### Workspace Members & Headcount");
      lines.push("| Name | Slack Username | User ID | Role |");
      lines.push("| :--- | :--- | :--- | :--- |");
      workspaceMembers.forEach(function(m) {
        const name = (m.profile && (m.profile.real_name || m.profile.display_name)) || m.real_name || m.name;
        const uname = "@" + (m.name || "user");
        const role = m.is_owner ? "Workspace Owner" : (m.is_admin ? "Admin" : "Member");
        lines.push("| " + name + " | " + uname + " | " + m.id + " | " + role + " |");
      });
      lines.push("");
    }

    if (totalMessages === 0 && channelsWithErrors.length > 0) {
      lines.push("CRITICAL SLACK PERMISSION NOTE:");
      lines.push("The Slack API returned permissions errors (e.g. not_in_channel or missing_scope) for the following channels:");
      channelsWithErrors.forEach(function(c) {
        lines.push("- " + (c.isDm ? "DM with " + c.displayName : "#" + c.displayName) + ": " + c.accessError);
      });
      lines.push("");
      lines.push("INSTRUCTIONS FOR YOUR RESPONSE:");
      lines.push("1. Explain clearly that Slack requires permission to read these channels.");
      lines.push("2. Tell the user to type `/invite @" + botUsername + "` inside each Slack channel (#new-channel, #social, etc.) so the bot can join.");
      lines.push("3. Only reference @" + botUsername + " and the connected workspace (" + workspace + "). Never reference any external workspace or generic names.");
      lines.push("4. NEVER mention Web Search or claim to be in offline mode — this is a direct Slack API integration permission issue.");
    }

    lines.push("");
    lines.push("### Channel and DM Overview");
    lines.push("| Name | Type | Messages | Access |");
    lines.push("| :--- | :--- | :--- | :--- |");
    resolvedChannels.forEach(function(c) {
      const type = c.isDm ? "Direct Message" : (c.isPrivate ? "Private Channel" : "Public Channel");
      const label = c.isDm ? ("DM: " + c.displayName) : ("#" + c.displayName);
      const msgCount = c.messages.length > 0 ? (c.messages.length + " messages") : "No messages";
      const access = c.accessError ? ("ERROR: " + c.accessError) : "OK";
      lines.push("| " + label + " | " + type + " | " + msgCount + " | " + access + " |");
    });

    lines.push("");
    lines.push("### Full Message History");
    resolvedChannels.forEach(function(chan) {
      const label = chan.isDm ? ("DM with " + chan.displayName) : ("#" + chan.displayName);
      lines.push("");
      lines.push("#### " + label);

      if (chan.accessError) {
        lines.push("Cannot read this channel: " + chan.accessError + ". The bot must be invited here first.");
        return;
      }
      if (chan.messages.length === 0) {
        lines.push("No messages in this channel.");
        return;
      }

      // Slack returns newest-first; reverse for chronological order
      const chronological = chan.messages.slice().reverse();
      chronological.forEach(function(m, i) {
        const sender = userNameCache[m.user] || m.user || "Unknown";
        let ts = "";
        if (m.ts) {
          ts = new Date(parseFloat(m.ts) * 1000).toLocaleString("en-US", {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "UTC",
          });
        }
        const text = (m.text || "")
          .replace(/\n/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        if (text) {
          lines.push("[" + (i + 1) + "] " + sender + " (" + ts + "): " + text);
        }
      });
    });

    const result = lines.join("\n");
    console.log("[MCP] buildSlackContext: " + result.length + " chars, " + resolvedChannels.length + " channels, " + totalMessages + " messages");
    return result;
  }
}

module.exports = new McpRuntimeService();