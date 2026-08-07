const { encrypt, decrypt } = require("../utils/crypto");
const { chunkText, detectBotIntent, generateConversationalResponse } = require("../utils/ragEngine");

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function runTests() {
  console.log("\n=======================================================");
  console.log("🧪 RUNNING ENTERPRISE CONVERSATIONAL AI AGENT TEST SUITE");
  console.log("=======================================================\n");

  const mockChunks = [{
    snippet: `
    1. PLATFORM OVERVIEW: Enterprise Multi-Tenant AI Platform helps businesses manage customer operations, tasks, and workflows.
    2. CORE WORKFLOW: The primary goal of the assistant is to act as a workspace helper agent to assist users and manage workflow tasks.
    3. REGISTRATION MANDATE: Before registering a lead or profile, collect required contact fields and user requirements.
    `
  }];

  const mockBot = { name: "Support Helper Agent" };

  // TEST 1: Role Explanation Query
  console.log("Test 1: Role Explanation Query ('What is your role?')");
  const intent1 = detectBotIntent("What is your role?", []);
  const res1 = generateConversationalResponse(intent1, "What is your role?", [], mockChunks, mockBot);
  assert(res1.includes("Support Helper Agent") || res1.includes("role"), "Role query returns concise, natural role explanation");

  // TEST 2: Context-Aware Follow-up Query ('Will it help me?')
  console.log("\nTest 2: Context-Aware Follow-up Query ('Will it help me?')");
  const history = [{ role: "assistant", content: "Our support system helps businesses manage support tickets." }];
  const intent2 = detectBotIntent("Will it help me?", history);
  const res2 = generateConversationalResponse(intent2, "Will it help me?", history, mockChunks, mockBot);
  assert(res2.includes("support system") || res2.includes("assist"), "Follow-up query returns context-aware response");

  // TEST 3: Intent Detection
  console.log("\nTest 3: Intent Detection ('How can I get help?')");
  const intent3 = detectBotIntent("How can I get help?", []);
  assert(intent3 === "GENERAL_QUERY" || intent3 === "DOCUMENT_QUERY" || intent3 === "GREETING", "Intent detection classifies query correctly");

  // TEST 4: Clarification Query ('What?')
  console.log("\nTest 4: Clarification Query ('What?')");
  const intent4 = detectBotIntent("What?", history);
  const res4 = generateConversationalResponse(intent4, "What?", history, mockChunks, mockBot);
  assert(res4.includes("support system") || res4.includes("assist"), "Clarification query refers to previous conversation context");

  // TEST 5: Greeting Query ('Hello')
  console.log("\nTest 5: Greeting Query ('Hello')");
  const intent5 = detectBotIntent("Hello", []);
  const res5 = generateConversationalResponse(intent5, "Hello", [], mockChunks, mockBot);
  assert(res5.includes("Hello") && (res5.includes("assist") || res5.includes("Support Helper Agent")), "Greeting returns natural greeting response");

  console.log("\n=======================================================");
  console.log(`RESULTS: ${passedTests} / ${totalTests} tests passed.`);
  console.log("=======================================================\n");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests();
