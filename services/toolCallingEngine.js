const { decrypt } = require("../utils/crypto");

const ACTION_INTENT_PATTERNS = [
  { actionType: "CREATE_CONTACT", pattern: /\b(create|add|register|insert)\s+(a\s+)?contact\b/i },
  { actionType: "UPDATE_CONTACT", pattern: /\b(update|modify|edit|change)\s+(a\s+)?contact\b/i },
  { actionType: "DELETE_CONTACT", pattern: /\b(delete|remove)\s+(a\s+)?contact\b/i },
  { actionType: "SEARCH_CONTACT", pattern: /\b(search|find|get|fetch|lookup)\s+(a\s+)?contact\b/i },
  { actionType: "CREATE_TICKET", pattern: /\b(create|open|raise|add)\s+(a\s+)?ticket\b/i },
  { actionType: "UPDATE_TICKET", pattern: /\b(update|resolve|close)\s+(a\s+)?ticket\b/i },
  { actionType: "CREATE_LEAD", pattern: /\b(create|add|convert)\s+(a\s+)?lead\b/i },
  { actionType: "UPDATE_LEAD", pattern: /\b(update|modify)\s+(a\s+)?lead\b/i },
];

/**
 * Detects if user message matches any configured tool action intent.
 */
const detectActionIntent = (message) => {
  if (!message || typeof message !== "string") return null;
  for (const item of ACTION_INTENT_PATTERNS) {
    if (item.pattern.test(message)) {
      return item.actionType;
    }
  }
  return null;
};

/**
 * Parses user text to extract fields for API payload (e.g. name, email, phone, id).
 */
const extractPayloadFromMessage = (message) => {
  const payload = {};
  if (!message || typeof message !== "string") return payload;

  const emailMatch = message.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/i);
  if (emailMatch) payload.email = emailMatch[0];

  const phoneMatch = message.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\+?\d{7,15}\b/);
  if (phoneMatch) payload.phone = phoneMatch[0];

  const idMatch = message.match(/\b(?:id|ID|#)\s*[:=]?\s*([a-zA-Z0-9_-]+)\b/);
  if (idMatch) payload.id = idMatch[1];

  // Extract name if available
  const nameMatch = message.match(/\b(?:name(?:d)?|contact|user|for)\s+([A-[Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  if (nameMatch && nameMatch[1]) {
    const parts = nameMatch[1].trim().split(/\s+/);
    payload.firstName = parts[0];
    if (parts.length > 1) payload.lastName = parts.slice(1).join(" ");
    payload.name = nameMatch[1];
  }

  return payload;
};

/**
 * Executes a configured BotApi request dynamically.
 */
const executeToolApi = async (botApi, extractedParams = {}) => {
  let targetUrl = botApi.url || `${botApi.baseUrl || ""}${botApi.endpoint || ""}`;

  // Replace path parameters (e.g., :id)
  Object.keys(extractedParams).forEach(key => {
    if (extractedParams[key]) {
      targetUrl = targetUrl.replace(`:${key}`, encodeURIComponent(extractedParams[key]));
    }
  });

  const headers = { "Content-Type": "application/json" };

  if (botApi.headers) {
    const customHeaders = botApi.headers instanceof Map ? Object.fromEntries(botApi.headers) : botApi.headers;
    Object.assign(headers, customHeaders);
  }

  if (botApi.authType === "apiKey" && botApi.encryptedApiKey) {
    try {
      headers["x-api-key"] = decrypt(botApi.encryptedApiKey);
    } catch (e) {
      headers["x-api-key"] = botApi.encryptedApiKey;
    }
  } else if (botApi.authType === "bearerToken" && botApi.encryptedBearerToken) {
    try {
      headers["Authorization"] = `Bearer ${decrypt(botApi.encryptedBearerToken)}`;
    } catch (e) {
      headers["Authorization"] = `Bearer ${botApi.encryptedBearerToken}`;
    }
  }

  const options = {
    method: (botApi.method || "GET").toUpperCase(),
    headers,
  };

  if (["POST", "PUT", "PATCH"].includes(options.method)) {
    options.body = JSON.stringify(extractedParams);
  }

  try {
    const response = await fetch(targetUrl, options);
    let responseData;
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
      responseData = await response.json();
    } else {
      responseData = { message: await response.text() };
    }

    return {
      success: response.ok,
      statusCode: response.status,
      data: responseData,
      endpoint: targetUrl,
      method: options.method,
      apiName: botApi.name,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      endpoint: targetUrl,
      method: options.method,
      apiName: botApi.name,
    };
  }
};

module.exports = {
  detectActionIntent,
  extractPayloadFromMessage,
  executeToolApi,
};
