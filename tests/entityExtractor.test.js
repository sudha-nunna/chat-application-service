const {
  detectIntent,
  extractEntities,
  validateEmail,
  validatePhone,
  validateTextField,
  getValidationStatus,
  isEntitiesComplete,
  calculateConfidence,
  preserveRawString
} = require("../utils/entityExtractor");

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
  console.log("🧪 RUNNING GENERAL CHAT CHATGPT BEHAVIOR TEST SUITE");
  console.log("=======================================================\n");

  // TEST 1: Casual & Entertainment Intent Classification
  console.log("Test 1: Casual & Entertainment Intent Classification");
  assert(detectIntent("tell me one joke") === "CASUAL_CONVERSATION", "'tell me one joke' detected as CASUAL_CONVERSATION");
  assert(detectIntent("tell me a joke") === "CASUAL_CONVERSATION", "'tell me a joke' detected as CASUAL_CONVERSATION");
  assert(detectIntent("what is your work") === "GENERAL_QUESTION", "'what is your work' detected as GENERAL_QUESTION");
  assert(detectIntent("ok why") === "GENERAL_QUESTION", "'ok why' detected as GENERAL_QUESTION");

  // TEST 2: Zero Profile Extraction on Jokes & Casual Messages
  console.log("\nTest 2: Zero Profile Extraction on Jokes & Casual Messages");
  const jokeResult = extractEntities("tell me one joke", {});
  assert(jokeResult.intent === "CASUAL_CONVERSATION", "Intent is CASUAL_CONVERSATION");
  assert(jokeResult.extracted.firstName === null, "firstName is null (Zero Extraction)");
  assert(jokeResult.extracted.lastName === null, "lastName is null (Zero Extraction)");
  assert(Object.keys(jokeResult.newlyExtracted).length === 0, "newlyExtracted is empty");

  // TEST 3: Profile Submission works when email or phone is provided
  console.log("\nTest 3: Explicit Profile Submission Parsing");
  const profileResult = extractEntities("Sudha Nunna sudha@gmail.com 1234567890 codegene", {});
  assert(profileResult.intent === "PROFILE_SUBMISSION", "Intent is PROFILE_SUBMISSION");
  assert(profileResult.extracted.firstName === "Sudha", "firstName is 'Sudha'");
  assert(profileResult.extracted.lastName === "Nunna", "lastName is 'Nunna'");
  assert(profileResult.extracted.email === "sudha@gmail.com", "email is 'sudha@gmail.com'");

  console.log("\n=======================================================");
  console.log(`RESULTS: ${passedTests} / ${totalTests} tests passed.`);
  console.log("=======================================================\n");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests();
