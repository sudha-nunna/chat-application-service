const Plan = require("../models/Plan");

const seedPlans = async () => {
  try {
    const count = await Plan.countDocuments();
    if (count === 0) {
      console.log("Seeding default SaaS subscription plans...");
      await Plan.insertMany([
        {
          key: "free",
          name: "Free",
          description: "Standard access for casual AI chat and basic experimentation.",
          monthlyPrice: 0,
          annualPrice: 0,
          priorityScore: 10,
          maxAgents: 1,
          maxMessagesPerDay: 50,
          maxKnowledgeFiles: 2,
          maxApiIntegrations: 0,
          features: [
            "Standard request queue priority (10)",
            "General chat capabilities",
            "Community support access",
          ],
          recommended: false,
          active: true,
          displayOrder: 1,
        },
        {
          key: "pro",
          name: "Pro",
          description: "High priority processing and expanded limits for power users.",
          monthlyPrice: 20,
          annualPrice: 16,
          priorityScore: 50,
          maxAgents: 10,
          maxMessagesPerDay: -1, // Unlimited
          maxKnowledgeFiles: 20,
          maxApiIntegrations: 5,
          features: [
            "High request queue priority (50)",
            "Faster AI completion response times",
            "RAG bot embeddings & file search",
            "Priority customer support",
          ],
          recommended: true,
          active: true,
          displayOrder: 2,
        },
        {
          key: "enterprise",
          name: "Enterprise",
          description: "Dedicated resources, unlimited agents, and highest queue priority.",
          monthlyPrice: 99,
          annualPrice: 79,
          priorityScore: 100,
          maxAgents: -1, // Unlimited
          maxMessagesPerDay: -1, // Unlimited
          maxKnowledgeFiles: -1, // Unlimited
          maxApiIntegrations: -1, // Unlimited
          features: [
            "Dedicated request queue priority (100)",
            "Zero latency queue waiting",
            "Custom model fine-tuning support",
            "Dedicated Account Manager",
            "SLA & security guarantees",
          ],
          recommended: false,
          active: true,
          displayOrder: 3,
        },
      ]);
      console.log("Default SaaS Subscription Plans seeded successfully.");
    }
  } catch (error) {
    console.error("Error seeding subscription plans:", error.message);
  }
};

module.exports = seedPlans;
