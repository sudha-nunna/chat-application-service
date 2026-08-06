const { Queue, Worker } = require("bullmq");
const { redis } = require("./redisClient");

// 1. Background Knowledge Processing Queue (Async Chunking & Vector Embedding)
const knowledgeQueue = new Queue("knowledgeProcessingQueue", {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

// 2. Background Knowledge Worker
const knowledgeWorker = new Worker(
  "knowledgeProcessingQueue",
  async (job) => {
    const { type, botId, fileId, textSnippet } = job.data;
    console.log(`🚀 [BULLMQ WORKER] Processing job '${type}' (${job.id}) for Bot ID: ${botId}`);

    if (type === "EMBEDDING_GENERATE") {
      const { generateEmbeddingVectorAsync } = require("./ragEngine");
      const vector = await generateEmbeddingVectorAsync(textSnippet);
      return { status: "success", vectorLength: vector?.length || 0 };
    }

    return { status: "completed", type };
  },
  { connection: redis }
);

knowledgeWorker.on("completed", (job) => {
  console.log(`✅ [BULLMQ JOB DONE] Job ${job.id} finished in background.`);
});

knowledgeWorker.on("failed", (job, err) => {
  console.error(`❌ [BULLMQ JOB FAILED] Job ${job?.id} error:`, err.message);
});

module.exports = {
  knowledgeQueue,
  knowledgeWorker
};
