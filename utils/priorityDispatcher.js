/**
 * Distributed In-Flight Priority Preemption Dispatcher
 * Priority Hierarchy: Enterprise (100) > Pro (50) > Free (10)
 *
 * If the cluster nodes are busy processing lower-priority requests (e.g. Free or Pro),
 * an incoming higher-priority request (Pro or Enterprise) will automatically preempt (abort)
 * the lower-priority stream in real time and immediately allocate the server node
 * to the higher-priority user without forcing them to wait.
 */

const { performance } = require("perf_hooks");

// Active Jobs Registry: jobId -> { jobId, userId, userPriority, nodeId, res, abortController, startTime }
const activeJobs = new Map();

/**
 * Registers an active streaming job in the preemption dispatcher registry
 */
function registerActiveJob(jobId, jobData) {
  activeJobs.set(jobId, {
    jobId,
    userId: jobData.userId,
    userPriority: Number(jobData.userPriority) || 10,
    nodeId: jobData.nodeId,
    res: jobData.res,
    abortController: jobData.abortController,
    startTime: performance.now()
  });
}

/**
 * Unregisters a streaming job when completed or terminated
 */
function unregisterActiveJob(jobId) {
  activeJobs.delete(jobId);
}

/**
 * Preempts (aborts & disconnects) lower-priority active jobs running on cluster nodes
 * if an incoming higher-priority request arrives and the server is busy.
 */
function preemptLowerPriorityJob(incomingPriority, clusterState) {
  const reqPriority = Number(incomingPriority) || 10;

  // Filter active jobs running on healthy nodes that have LOWER priority than incoming request
  const candidates = Array.from(activeJobs.values()).filter(
    job => job.userPriority < reqPriority && job.abortController && !job.abortController.signal.aborted
  );

  if (candidates.length === 0) {
    return null; // No preemptible victim found
  }

  // Pick the lowest priority candidate first (e.g., Free 10 before Pro 50)
  candidates.sort((a, b) => {
    if (a.userPriority !== b.userPriority) {
      return a.userPriority - b.userPriority; // Ascending: lowest priority first
    }
    return b.startTime - a.startTime; // Dynamic tie-breaker: newest job first
  });

  const victim = candidates[0];

  // Execute Preemption
  try {
    console.log(`\n⚡ =================== [PRIORITY PREEMPTION DISPATCH] ===================`);
    console.log(`  ├── 🚨 Preempted Victim Stream: User ${victim.userId} (Priority: ${victim.userPriority}) on ${victim.nodeId}`);
    console.log(`  ├── 👑 Target Incoming Request: Priority ${reqPriority}`);
    console.log(`  └── ⚡ Aborting lower-priority fetch stream & releasing node slot...`);
    console.log(`========================================================================\n`);

    // 1. Abort downstream LLM fetch stream
    victim.abortController.abort();

    // 2. Write SSE pause notice to victim client
    if (victim.res && !victim.res.writableEnded) {
      const noticeText = "\n\n⚠️ Stream paused due to higher-priority request. Click Resume.";
      victim.res.write(`data: ${JSON.stringify({ type: "chunk", chunk: noticeText, text: noticeText, paused: true })}\n\n`);
      victim.res.write(`data: ${JSON.stringify({ type: "pause", paused: true })}\n\n`);
      victim.res.write("data: [DONE]\n\n");
      victim.res.end();
    }
  } catch (err) {
    console.error("Error during job preemption execution:", err.message);
  }

  // 3. Remove victim from registry & decrement active node count
  unregisterActiveJob(victim.jobId);
  const targetNode = clusterState.find(n => n.id === victim.nodeId);
  if (targetNode) {
    targetNode.activeRequests = Math.max(0, targetNode.activeRequests - 1);
  }

  return victim;
}

/**
 * Smart Node Selector with In-Flight Priority Preemption.
 * Attempts to find an idle node. If none are idle and an incoming high-priority request arrives,
 * preempts a lower-priority active stream to free up node capacity immediately.
 */
function selectBestClusterNodeWithPreemption(userPriority, clusterState, isFailover = false) {
  const reqPriority = Number(userPriority) || 10;
  const nodes = Array.isArray(clusterState) ? clusterState : [];

  // Filter only active, healthy nodes
  const activeNodes = nodes.filter(n => n.isActive !== false && n.status === "ACTIVE");

  if (activeNodes.length === 0) {
    return nodes[0] || null;
  }

  // 1. Check for idle active node with highest priorityScore
  const idleNodes = activeNodes.filter(n => n.activeRequests === 0);
  if (idleNodes.length > 0) {
    idleNodes.sort((a, b) => {
      const pA = typeof a.priorityScore === "number" ? a.priorityScore : (a.priority || 10);
      const pB = typeof b.priorityScore === "number" ? b.priorityScore : (b.priority || 10);
      if (pB !== pA) return pB - pA;
      return (a.latency || 0) - (b.latency || 0);
    });
    return idleNodes[0];
  }

  // 2. Preemption of lower-priority jobs if all are busy
  if (!isFailover) {
    const preemptedVictim = preemptLowerPriorityJob(reqPriority, activeNodes);
    if (preemptedVictim) {
      const freedNode = activeNodes.find(n => n.id === preemptedVictim.nodeId);
      if (freedNode) return freedNode;
    }
  }

  // 3. Fallback: Select active node with lowest active task count & highest priority
  activeNodes.sort((a, b) => {
    if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
    const pA = typeof a.priorityScore === "number" ? a.priorityScore : (a.priority || 10);
    const pB = typeof b.priorityScore === "number" ? b.priorityScore : (b.priority || 10);
    return pB - pA;
  });

  return activeNodes[0];
}

module.exports = {
  registerActiveJob,
  unregisterActiveJob,
  preemptLowerPriorityJob,
  selectBestClusterNodeWithPreemption,
  activeJobs
};
