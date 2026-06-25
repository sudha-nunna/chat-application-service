const { z } = require("zod");

// Define exact request validations rulesets parameters schema definitions
exports.sendMessageSchema = z.object({
  message: z.string({
    required_error: "Message input parameters field explicitly required context parameters",
  }).min(1, { message: "Message cannot be an empty empty prompt string token value" }).max(4000),
});