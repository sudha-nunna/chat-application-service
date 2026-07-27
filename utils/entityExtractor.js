/**
 * Intent-Driven Zero-Mutation Entity Extraction & Profile Locking Engine
 * 
 * Features:
 * 1. Profile Lock Mechanism: Confirmed profiles (isConfirmed === true) are LOCKED and IMMUTABLE.
 * 2. General Chat Disambiguation: Casual requests ("tell me a joke", "write code", "explain quantum physics") map to CASUAL_CONVERSATION / GENERAL_QUESTION.
 * 3. Zero extraction on general knowledge, jokes, or casual conversation.
 */

// Regex patterns
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/i;
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\+?\d{7,15}\b/;

// Conversational filler words, question words, verbs, meta-words, joke/entertainment words to IGNORE during token parsing
const IGNORE_WORDS = new Set([
  // Greetings & Conversational Filler
  "ok", "okay", "hi", "hello", "hey", "yes", "yep", "sure", "thanks", "thank",
  "you", "my", "name", "is", "i", "am", "email", "phone", "number", "company",
  "at", "for", "from", "and", "with", "the", "details", "are", "info", "please",
  "register", "contact", "here", "this", "our", "null", "none", "n/a", "update",
  "change", "actually", "correction", "correct", "wrong", "incorrect", "not",
  "confirm", "confirmed", "confirmation", "approved", "proceed", "fix", "me", "gather",
  // Entertainment, General Chat & Meta-Words (NEVER EXTRACT AS NAMES)
  "joke", "jokes", "funny", "one", "two", "three", "tell", "say", "speak", "story",
  "poem", "code", "coding", "script", "explain", "write", "about", "thing", "anything",
  "what", "why", "how", "who", "when", "where", "which", "will", "do", "does",
  "did", "can", "could", "would", "should", "shall", "is", "are", "was", "were",
  "have", "has", "had", "use", "used", "need", "needed", "want", "wanted",
  "provide", "give", "show", "data", "information", "details", "names",
  "firstname", "lastname", "first", "last", "above", "below", "following", "same",
  "check", "once", "see", "there", "it", "so", "that", "again", "suit", "case",
  "far", "take", "taking", "response", "giving", "happened", "these", "role", "collected",
  "display", "profile", "retrieval", "view", "work"
]);

function validateEmail(email) {
  if (!email || typeof email !== "string" || email === "null") return false;
  const trimmed = email.trim();
  const emailValidRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailValidRegex.test(trimmed);
}

function validatePhone(phone) {
  if (!phone || typeof phone !== "string" || phone === "null") return false;
  const trimmed = phone.trim();
  const digitsOnly = trimmed.replace(/\D/g, "");
  return digitsOnly.length >= 7 && digitsOnly.length <= 15;
}

function validateTextField(text) {
  if (!text || typeof text !== "string" || text === "null") return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
}

function preserveRawString(val) {
  if (!val || val === "null") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Classifies message intent into 8 primary categories:
 * - CONFIRMATION
 * - DATA_QUERY
 * - PROFILE_CORRECTION
 * - PRODUCT_INQUIRY
 * - GENERAL_QUESTION
 * - PROFILE_SUBMISSION
 * - ONBOARDING
 * - CASUAL_CONVERSATION
 */
function detectIntent(message, currentMemory = {}) {
  if (!message || typeof message !== "string") return "CASUAL_CONVERSATION";
  const trimmed = message.trim().toLowerCase();

  // 1. CONFIRMATION INTENT ("ok confirm", "yes confirm", "confirm", "confirmed", "looks good", "approved")
  if (
    /^(yes|yes\s+confirm|ok\s+confirm|ok\s+confirmed|confirm|confirmed|looks\s+good|that\s+is\s+correct|approved|proceed)$/i.test(trimmed) ||
    /\b(ok\s+confirm|yes\s+confirm|confirm\s+details|information\s+is\s+correct|confirm\s+my\s+details)\b/i.test(trimmed)
  ) {
    return "CONFIRMATION";
  }

  // 2. PROFILE_CORRECTION INTENT ("update profile", "change details", "correct information", "no wrong", "wrong", "incorrect", "fix details")
  if (
    /^(no\s+wrong|wrong|incorrect|reset|clear|start\s+over|update\s+profile|change\s+details)$/i.test(trimmed) ||
    /\b(update\s+profile|change\s+details|correct\s+information|is\s+wrong|wrong|incorrect\s+data|not\s+my\s+details|these\s+details\s+are\s+wrong|fix\s+details|correction)\b/i.test(trimmed)
  ) {
    return "PROFILE_CORRECTION";
  }

  // 3. DATA_QUERY / RETRIEVAL INTENT ("once give me data that you gather above", "show my details", "give me my information", "display profile")
  if (
    /\b(give\s+(?:me\s+)?data|gather\s+above|collected\s+data|show\s+(?:my\s+)?details|view\s+(?:my\s+)?details|display\s+(?:my\s+)?profile|what\s+(?:details|info|data)\s+(?:did\s+you|have\s+you)|list\s+(?:my\s+)?info|give\s+me\s+my\s+information|saved\s+data)\b/i.test(trimmed)
  ) {
    return "DATA_QUERY";
  }

  // 4. GENERAL CASUAL CONVERSATION & ENTERTAINMENT ("tell me a joke", "tell me one joke", "joke", "tell a story", "write a poem", "say something funny")
  if (
    /\b(joke|jokes|funny|story|poem|riddle|song|quote|laugh|entertainment)\b/i.test(trimmed) ||
    /^(tell|say|write|sing|recite)\s+(?:me\s+)?(?:a|an|one|some)?\s*(?:joke|jokes|story|poem|funny|something)?$/i.test(trimmed)
  ) {
    return "CASUAL_CONVERSATION";
  }

  // 5. PRODUCT_INQUIRY INTENT ("what is the use of it", "pricing", "features", "walkthrough details", "how does Allvion work")
  if (
    /\b(use\s+of\s+it|what\s+is\s+the\s+use|pricing|features|walkthrough|how\s+does\s+it\s+work|platform\s+features|crm\s+features|what\s+you\s+need|what\s+do\s+you\s+need)\b/i.test(trimmed)
  ) {
    return "PRODUCT_INQUIRY";
  }

  // 6. GENERAL_QUESTION INTENT ("what", "what is your role", "what is your work", "what happened", "who are you")
  if (
    trimmed.endsWith("?") ||
    /^(what|why|how|who|when|where|which|can\s+you|could\s+you|would\s+you|tell\s+me|explain|ok\s+why)$/i.test(trimmed) ||
    /\b(what\s+is\s+your\s+role|what\s+is\s+your\s+work|what\s+you\s+will\s+do|what\s+happened|who\s+are\s+you|what\s+can\s+you\s+do)\b/i.test(trimmed)
  ) {
    return "GENERAL_QUESTION";
  }

  // 7. PROFILE_SUBMISSION INTENT (User explicitly provides profile data: email, phone, or name pattern)
  const hasEmail = EMAIL_REGEX.test(trimmed);
  const hasPhone = PHONE_REGEX.test(trimmed);
  const hasKV = /(?:first\s*name|last\s*name|email|phone|company)\s*[:=]/i.test(trimmed);
  const hasMyNameIs = /(?:my\s+name\s+is|i\s+am|this\s+is)\s+[a-z]+/i.test(trimmed);

  if (hasEmail || hasPhone || hasKV || hasMyNameIs) {
    return "PROFILE_SUBMISSION";
  }

  // 8. ONBOARDING INTENT ("yes", "sure", "okay", "ok", "let's start", "walk me through")
  if (/^(yes|sure|okay|ok|let's\s+start|start|register|walk\s+me\s+through)$/i.test(trimmed)) {
    return "ONBOARDING";
  }

  // 9. DEFAULT CASUAL_CONVERSATION INTENT ("hi", "hello", "thanks", general knowledge)
  return "CASUAL_CONVERSATION";
}

/**
 * Main deterministic entity extractor function driven by Intent Classification and Profile Locking.
 */
function extractEntities(text, currentEntities = {}) {
  const intent = detectIntent(text, currentEntities);
  const isProfileLocked = currentEntities.isConfirmed === true;

  let memoryBase = { ...currentEntities };
  let isCorrectionEvent = false;

  // PROFILE_CORRECTION Mode: UNLOCK profile and clear unverified fields for clean update
  if (intent === "PROFILE_CORRECTION") {
    isCorrectionEvent = true;
    memoryBase = {
      firstName: null,
      lastName: null,
      email: currentEntities.email || null,
      phone: currentEntities.phone || null,
      companyName: null,
      description: null,
      isConfirmed: false
    };
  } else if (intent === "CONFIRMATION") {
    memoryBase.isConfirmed = true;
  }

  const defaultMemory = Object.freeze({
    firstName: memoryBase.firstName || null,
    lastName: memoryBase.lastName || null,
    email: memoryBase.email || null,
    phone: memoryBase.phone || null,
    companyName: memoryBase.companyName || null,
    description: memoryBase.description || null,
    isConfirmed: memoryBase.isConfirmed || false
  });

  // ZERO EXTRACTION ON CASUAL CONVERSATION, GENERAL QUESTIONS, PRODUCT INQUIRIES, DATA RETRIEVAL OR LOCKED PROFILES!
  const isExplicitProfileInput = intent === "PROFILE_SUBMISSION" || (intent === "PROFILE_CORRECTION" && (EMAIL_REGEX.test(text) || PHONE_REGEX.test(text)));

  if (!isExplicitProfileInput || isProfileLocked || !text || typeof text !== "string") {
    const confidence = calculateConfidence(defaultMemory);
    return Object.freeze({
      intent,
      extracted: defaultMemory,
      newlyExtracted: Object.freeze({}),
      confidenceScores: Object.freeze(confidence.scores),
      overallConfidence: confidence.overall,
      validationResults: Object.freeze(getValidationStatus(defaultMemory)),
      isComplete: isEntitiesComplete(defaultMemory),
      isCorrectionEvent: false,
      isLocked: isProfileLocked,
      stateUpdated: intent === "CONFIRMATION"
    });
  }

  const rawMessage = text.trim();
  const newlyExtracted = {};

  // 1. Explicit Key-Value Pair Parsing
  const kvPatterns = [
    { key: "firstName", regex: /(?:first\s*name|fname|given\s*name)\s*[:=]\s*([^\n,;]+)/i },
    { key: "lastName", regex: /(?:last\s*name|lname|surname|family\s*name)\s*[:=]\s*([^\n,;]+)/i },
    { key: "email", regex: /(?:email|e-mail|mail)\s*[:=]\s*([^\n,;\s]+)/i },
    { key: "phone", regex: /(?:phone|mobile|cell|contact|tel)\s*[:=]\s*([^\n,;]+)/i },
    { key: "companyName", regex: /(?:company|organization|org|business|company\s*name)\s*[:=]\s*([^\n,;]+)/i },
    { key: "description", regex: /(?:description|requirements|notes|details|summary)\s*[:=]\s*([^\n,;]+)/i },
  ];

  for (const { key, regex } of kvPatterns) {
    const match = rawMessage.match(regex);
    if (match && match[1]) {
      const val = match[1].trim();
      if (key === "email") {
        if (validateEmail(val)) newlyExtracted.email = val;
      } else if (key === "phone") {
        if (validatePhone(val)) newlyExtracted.phone = val;
      } else {
        if (validateTextField(val)) newlyExtracted[key] = preserveRawString(val);
      }
    }
  }

  // 2. Email Extraction via Regex Only
  if (!newlyExtracted.email) {
    const emailMatch = rawMessage.match(EMAIL_REGEX);
    if (emailMatch) {
      const candidateEmail = emailMatch[0].trim();
      if (validateEmail(candidateEmail)) {
        newlyExtracted.email = candidateEmail;
      }
    }
  }

  // 3. Phone Extraction via Regex Only
  if (!newlyExtracted.phone) {
    const phoneMatch = rawMessage.match(PHONE_REGEX);
    if (phoneMatch) {
      const candidatePhone = phoneMatch[0].trim();
      if (validatePhone(candidatePhone)) {
        newlyExtracted.phone = candidatePhone;
      }
    }
  }

  // 4. Conversational Pattern Matching
  if (!newlyExtracted.firstName && !newlyExtracted.lastName) {
    const nameMatch = rawMessage.match(/(?:\bmy\s+name\s+is\b|\bi\s+am\b|\bthis\s+is\b)\s+([A-Za-z'-]+)\s+([A-Za-z'-]+)/i);
    if (nameMatch) {
      newlyExtracted.firstName = preserveRawString(nameMatch[1]);
      newlyExtracted.lastName = preserveRawString(nameMatch[2]);
    } else {
      const singleNameMatch = rawMessage.match(/(?:\bmy\s+name\s+is\b|\bi\s+am\b)\s+([A-Za-z'-]+)/i);
      if (singleNameMatch && !IGNORE_WORDS.has(singleNameMatch[1].toLowerCase())) {
        newlyExtracted.firstName = preserveRawString(singleNameMatch[1]);
      }
    }
  }

  // 5. Multi-Token Unstructured Parsing
  const tokens = rawMessage.split(/[\s,]+/).filter(t => t.length > 0);
  const remainingTokens = [];

  for (const token of tokens) {
    const cleanToken = token.replace(/^[,\s;:]+|[,\s;:]+$/g, "");
    if (!cleanToken) continue;

    if (newlyExtracted.firstName && cleanToken.toLowerCase() === newlyExtracted.firstName.toLowerCase()) {
      continue;
    }
    if (newlyExtracted.lastName && cleanToken.toLowerCase() === newlyExtracted.lastName.toLowerCase()) {
      continue;
    }
    if (newlyExtracted.email && cleanToken.toLowerCase() === newlyExtracted.email.toLowerCase()) {
      continue;
    }
    if (newlyExtracted.phone && cleanToken.replace(/\D/g, "") === newlyExtracted.phone.replace(/\D/g, "")) {
      continue;
    }
    if (validateEmail(cleanToken) || validatePhone(cleanToken)) {
      continue;
    }
    if (IGNORE_WORDS.has(cleanToken.toLowerCase())) {
      continue;
    }

    remainingTokens.push(cleanToken);
  }

  if (remainingTokens.length > 0) {
    let tokenIndex = 0;
    const shouldOverwriteNames = intent === "PROFILE_CORRECTION" || newlyExtracted.email || newlyExtracted.phone || remainingTokens.length >= 2;

    if ((shouldOverwriteNames || !defaultMemory.firstName) && tokenIndex < remainingTokens.length) {
      newlyExtracted.firstName = preserveRawString(remainingTokens[tokenIndex++]);
    }

    if ((shouldOverwriteNames || !defaultMemory.lastName) && tokenIndex < remainingTokens.length) {
      newlyExtracted.lastName = preserveRawString(remainingTokens[tokenIndex++]);
    }

    if ((shouldOverwriteNames || !defaultMemory.companyName) && tokenIndex < remainingTokens.length) {
      newlyExtracted.companyName = preserveRawString(remainingTokens[tokenIndex++]);
    }
  }

  // 6. Merge & Overwrite
  const mergedEntities = Object.freeze({
    firstName: newlyExtracted.firstName !== undefined ? newlyExtracted.firstName : defaultMemory.firstName,
    lastName: newlyExtracted.lastName !== undefined ? newlyExtracted.lastName : defaultMemory.lastName,
    email: newlyExtracted.email !== undefined ? newlyExtracted.email : defaultMemory.email,
    phone: newlyExtracted.phone !== undefined ? newlyExtracted.phone : defaultMemory.phone,
    companyName: newlyExtracted.companyName !== undefined ? newlyExtracted.companyName : defaultMemory.companyName,
    description: newlyExtracted.description !== undefined ? newlyExtracted.description : defaultMemory.description,
    isConfirmed: defaultMemory.isConfirmed || false
  });

  const confidence = calculateConfidence(mergedEntities);
  const validationResults = getValidationStatus(mergedEntities);
  const isComplete = isEntitiesComplete(mergedEntities);
  const stateUpdated = Object.keys(newlyExtracted).length > 0 || isCorrectionEvent;

  return Object.freeze({
    intent,
    extracted: mergedEntities,
    newlyExtracted: Object.freeze(newlyExtracted),
    confidenceScores: Object.freeze(confidence.scores),
    overallConfidence: confidence.overall,
    validationResults: Object.freeze(validationResults),
    isComplete,
    isCorrectionEvent,
    isLocked: false,
    stateUpdated
  });
}

function calculateConfidence(entities) {
  const scores = Object.freeze({
    firstName: validateTextField(entities.firstName) ? 1.0 : 0.0,
    lastName: validateTextField(entities.lastName) ? 1.0 : 0.0,
    email: validateEmail(entities.email) ? 1.0 : 0.0,
    phone: validatePhone(entities.phone) ? 1.0 : 0.0,
    companyName: entities.companyName ? (validateTextField(entities.companyName) ? 1.0 : 0.0) : 1.0,
    description: entities.description ? (validateTextField(entities.description) ? 1.0 : 0.0) : 1.0,
  });

  const requiredScores = [scores.firstName, scores.lastName, scores.email, scores.phone];
  const overall = requiredScores.reduce((acc, val) => acc + val, 0) / requiredScores.length;

  return { scores, overall };
}

function getValidationStatus(entities) {
  return Object.freeze({
    firstName: validateTextField(entities.firstName),
    lastName: validateTextField(entities.lastName),
    email: validateEmail(entities.email),
    phone: validatePhone(entities.phone),
    companyName: entities.companyName ? validateTextField(entities.companyName) : true,
    description: entities.description ? validateTextField(entities.description) : true,
  });
}

function isEntitiesComplete(entities) {
  const status = getValidationStatus(entities);
  return status.firstName && status.lastName && status.email && status.phone;
}

module.exports = {
  detectIntent,
  extractEntities,
  validateEmail,
  validatePhone,
  validateTextField,
  getValidationStatus,
  isEntitiesComplete,
  calculateConfidence,
  preserveRawString
};
