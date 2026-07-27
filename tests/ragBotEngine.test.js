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
    1. PLATFORM OVERVIEW: Allvion CRM helps businesses manage customer relationships, contacts, and sales pipelines.
    2. CORE WORKFLOW: The primary goal of the assistant is to act as a workspace helper agent to qualify leads and register contact profiles.
    3. REGISTRATION MANDATE: Before registering a lead, collect First Name, Last Name, Email Address, Phone Number, Company Name, and requirements.
    `
  }];

  // TEST 1: Role Explanation Query
  console.log("Test 1: Role Explanation Query ('What is your role?')");
  const intent1 = detectBotIntent("What is your role?", []);
  const res1 = generateConversationalResponse(intent1, "What is your role?", [], mockChunks);
  assert(res1 === "My role is to act as a workspace helper agent that assists with lead qualification and profile registration.", "Role query returns concise, natural role explanation");

  // TEST 2: Context-Aware Follow-up Query ('Will it help me?')
  console.log("\nTest 2: Context-Aware Follow-up Query ('Will it help me?')");
  const history = [{ role: "assistant", content: "Allvion CRM helps businesses manage customer relationships." }];
  const intent2 = detectBotIntent("Will it help me?", history);
  const res2 = generateConversationalResponse(intent2, "Will it help me?", history, mockChunks);
  assert(res2.includes("That depends on your needs") && res2.includes("Allvion CRM can be very useful"), "Follow-up query returns context-aware response");

  // TEST 3: Registration Guidance Query ('What do I need to do now?')
  console.log("\nTest 3: Registration Guidance Query ('What do I need to do now?')");
  const intent3 = detectBotIntent("What do I need to do now?", []);
  const res3 = generateConversationalResponse(intent3, "What do I need to do now?", [], mockChunks);
  assert(res3.includes("First Name") && res3.includes("Email Address") && res3.includes("Company Name"), "Registration query returns structured registration guidance");

  // TEST 4: Clarification Query ('What?')
  console.log("\nTest 4: Clarification Query ('What?')");
  const intent4 = detectBotIntent("What?", history);
  const res4 = generateConversationalResponse(intent4, "What?", history, mockChunks);
  assert(res4.includes("I was explaining that Allvion CRM helps businesses manage customer relationships"), "Clarification query refers to previous conversation context");

  // TEST 5: Greeting Query ('Hello')
  console.log("\nTest 5: Greeting Query ('Hello')");
  const intent5 = detectBotIntent("Hello", []);
  const res5 = generateConversationalResponse(intent5, "Hello", [], mockChunks);
  assert(res5.includes("How can I assist you?") || res5.includes("help you understand and use Allvion CRM"), "Greeting returns natural greeting response");

  console.log("\n=======================================================");
  console.log(`RESULTS: ${passedTests} / ${totalTests} tests passed.`);
  console.log("=======================================================\n");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests();
