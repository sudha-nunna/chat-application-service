require("dotenv").config();

const { sendAlert } = require("./services/notifications/telegramAlertService");
const { ALERT_TYPES, SEVERITY } = require("./config/alertTypes");

async function testAllTopics() {
  console.log("🚀 Testing Telegram Topics...\n");

  const tests = [
    {
      type: ALERT_TYPES.CRITICAL,
      severity: SEVERITY.CRITICAL,
      title: "🚨 Critical Alert Test",
      message: "Testing Critical System Alerts Topic"
    },
    {
      type: ALERT_TYPES.AI,
      severity: SEVERITY.ERROR,
      title: "🤖 AI Alert Test",
      message: "Testing AI & LLM Errors Topic"
    },
    {
      type: ALERT_TYPES.MCP,
      severity: SEVERITY.ERROR,
      title: "🔌 MCP Alert Test",
      message: "Testing MCP & External Integrations Topic"
    },
    {
      type: ALERT_TYPES.JOBS,
      severity: SEVERITY.WARN,
      title: "⚙️ Jobs Alert Test",
      message: "Testing Background Jobs & Queues Topic"
    },
    {
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.INFO,
      title: "👨‍💼 Admin Alert Test",
      message: "Testing Admin & Business Operations Topic"
    },
    {
      type: ALERT_TYPES.DEPLOYMENT,
      severity: SEVERITY.INFO,
      title: "🚀 Deployment Alert Test",
      message: "Testing Deployments & System Health Topic"
    }
  ];

  for (const alert of tests) {
    try {
      console.log(`Sending -> ${alert.type}`);

      await sendAlert({
        ...alert,
        meta: {
          test: true,
          timestamp: new Date().toISOString()
        }
      });

      console.log(`✅ Sent -> ${alert.type}`);
    } catch (err) {
      console.error(`❌ Failed -> ${alert.type}`, err.message);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log("\n🎉 All Topic Tests Completed");
}

testAllTopics();