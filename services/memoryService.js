const BotConversation = require("../models/BotConversation");
const BotMessage = require("../models/BotMessage");
const Summary = require("../models/Summary");
const { generateLLMSummary } = require("../utils/ragEngine");

class MemoryService {
  /**
   * Non-blocking background trigger for conversation summarization.
   * Runs completely out-of-band via setImmediate to ensure 0ms latency impact on user responses.
   */
  triggerBackgroundSummaryUpdate(conversationId, botId = null) {
    if (!conversationId) return;

    setImmediate(async () => {
      try {
        const totalMessages = await BotMessage.countDocuments({ conversationId });
        // Trigger summary generation every 8 messages after reaching 8 threshold
        if (totalMessages < 8 || totalMessages % 8 !== 0) {
          return;
        }

        const conversation = await BotConversation.findById(conversationId);
        if (!conversation) return;

        // Fetch recent 10 messages for summary compilation
        const recentMessages = await BotMessage.find({ conversationId })
          .sort({ createdAt: -1 })
          .limit(10);
        recentMessages.reverse();

        const newSummary = await generateLLMSummary(recentMessages, conversation.conversationSummary || "");
        if (newSummary && newSummary.trim()) {
          conversation.conversationSummary = newSummary.trim();
          await conversation.save();

          await Summary.findOneAndUpdate(
            { chatId: conversationId },
            {
              summarizedContent: newSummary.trim(),
              lastUpdatedMessageId: recentMessages[recentMessages.length - 1]._id
            },
            { upsert: true }
          );

          console.log(`🧠 [BACKGROUND MEMORY SERVICE] Updated rolling summary for bot conversation ${conversationId} (${totalMessages} total msgs).`);
        }
      } catch (err) {
        console.error(`⚠️ [BACKGROUND MEMORY SERVICE ERROR] Failed to update summary for ${conversationId}:`, err.message);
      }
    });
  }

  /**
   * Helper to retrieve conversation summary
   */
  async getConversationSummary(conversationId) {
    if (!conversationId) return "";
    try {
      const conv = await BotConversation.findById(conversationId).select("conversationSummary");
      if (conv?.conversationSummary) return conv.conversationSummary;

      const summaryDoc = await Summary.findOne({ chatId: conversationId }).select("summarizedContent");
      return summaryDoc?.summarizedContent || "";
    } catch (e) {
      return "";
    }
  }
}

module.exports = new MemoryService();
