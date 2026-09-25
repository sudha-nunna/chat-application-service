"use strict";

const { sendAlert } = require("./telegramAlertService");
const { ALERT_TYPES, SEVERITY } = require("../../config/alertTypes");

/**
 * Unified Alert Manager — Facade and Backward Compatibility Adapter
 */
const alertManager = {
  sendAlert,

  // ── Backward Compatibility: Legacy Functions ──────────────────────

  /**
   * Legacy alert_group function
   */
  alert_group: async (message, type = "err") => {
    const topicMap = {
      err:     ALERT_TYPES.CRITICAL,
      user:    ALERT_TYPES.ADMIN,
      cron:    ALERT_TYPES.JOBS,
      ferr:    ALERT_TYPES.CRITICAL,
      support: ALERT_TYPES.ADMIN
    };

    const targetType = topicMap[type] || ALERT_TYPES.CRITICAL;
    const severity = (type === "err" || type === "ferr") ? SEVERITY.CRITICAL : SEVERITY.INFO;

    await sendAlert({
      type: targetType,
      severity,
      title: `Legacy Alert [${type.toUpperCase()}]`,
      message: typeof message === "string" ? message : JSON.stringify(message)
    });
  },

  /**
   * Legacy codegene_alert function
   */
  codegene_alert: async (message, type = "cg") => {
    await sendAlert({
      type: ALERT_TYPES.DEPLOYMENT,
      severity: SEVERITY.INFO,
      title: "CodeGene System Alert",
      message: typeof message === "string" ? message : JSON.stringify(message)
    });
  },

  // ── Admin & Business Operations Helpers (Topic #9) ─────────────────

  notifyPlanCreated: async (adminEmail, planDetails) => {
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.INFO,
      title: "👨‍💼 Plan Created",
      message: `New plan "${planDetails.name || 'Custom Plan'}" was created by ${adminEmail}`,
      meta: planDetails
    });
  },

  notifyPlanUpdated: async (adminEmail, planDetails) => {
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.INFO,
      title: "👨‍💼 Plan Updated",
      message: `Plan "${planDetails.name || 'Custom Plan'}" was updated by ${adminEmail}`,
      meta: planDetails
    });
  },

  notifyServerNodeToggled: async (adminEmail, nodeName, isEnabled) => {
    const statusText = isEnabled ? "Enabled" : "Disabled";
    const emoji = isEnabled ? "✅" : "⚠️";
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: isEnabled ? SEVERITY.INFO : SEVERITY.WARN,
      title: `${emoji} ServerNode ${statusText}`,
      message: `Node "${nodeName}" was set to ${statusText.toLowerCase()} by ${adminEmail}`,
      meta: { nodeName, isEnabled, updatedBy: adminEmail }
    });
  },

  notifyCreditsAdjusted: async (adminEmail, targetUserId, creditAmount, reason) => {
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.INFO,
      title: "🪙 Credits Manually Adjusted",
      message: `Admin ${adminEmail} adjusted credits for User [${targetUserId}] by ${creditAmount > 0 ? '+' : ''}${creditAmount}`,
      meta: { targetUserId, creditAmount, reason, adminEmail }
    });
  },

  notifyEnterpriseSubCreated: async (customerName, subscriptionDetails) => {
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.INFO,
      title: "🎉 Enterprise Subscription Created",
      message: `Enterprise subscription activated for customer: ${customerName}`,
      meta: subscriptionDetails
    });
  },

  notifyCriticalConfigChanged: async (adminEmail, configKey, oldValue, newValue) => {
    await sendAlert({
      type: ALERT_TYPES.ADMIN,
      severity: SEVERITY.WARN,
      title: "🔐 Critical Config Changed",
      message: `Configuration "${configKey}" was changed by ${adminEmail}`,
      meta: { configKey, oldValue, newValue, adminEmail }
    });
  }
};

module.exports = alertManager;
