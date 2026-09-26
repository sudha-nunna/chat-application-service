/**
 * notificationController.js
 * Controller endpoints for Notification History, O(1) Unread Count, Preferences, and Intelligence Schedules.
 */

const Notification = require("../models/Notification");
const NotificationPreference = require("../models/NotificationPreference");
const IntelligenceSchedule = require("../models/IntelligenceSchedule");
const User = require("../models/User");
const { normalizeTopic } = require("../services/topicResolver");
const { resolveSourceType } = require("../services/sourceResolver");
const { calculateScheduleTimestamps } = require("../services/timezoneService");

// Safe User ID extraction helper supporting all JWT payload structures (.id, ._id, .userId)
const getUserId = (req) => req.user?.id || req.user?._id || req.user?.userId;

// 1. Get Paginated User Notifications
exports.getNotifications = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "User authentication required" });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = { userId };
    if (req.query.read !== undefined) {
      filter.read = req.query.read === "true";
    }
    if (req.query.type) {
      filter.type = req.query.type;
    }
    if (req.query.sourceType) {
      filter.sourceType = req.query.sourceType;
    }

    const [notifications, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ]);

    // Update user's lastActiveAt timestamp to reset inactivity auto-pause timers
    User.findByIdAndUpdate(userId, { lastActiveAt: new Date() }).catch(() => {});

    return res.status(200).json({
      success: true,
      notifications,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Error fetching notifications:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch notifications" });
  }
};

// 2. O(1) Unread Count Endpoint
exports.getUnreadCount = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(200).json({ success: true, unreadCount: 0 });

    const user = await User.findById(userId).select("unreadNotificationCount");
    
    // Fast O(1) return stored count from User document
    const unreadCount = user ? user.unreadNotificationCount || 0 : 0;
    return res.status(200).json({ success: true, unreadCount });
  } catch (err) {
    console.error("Error fetching unread count:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch unread count", unreadCount: 0 });
  }
};

// 3. Mark Single Notification as Read
exports.markAsRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });
    
    const targetId = req.params.id || req.body?.id || (Array.isArray(req.body?.notificationIds) ? req.body.notificationIds[0] : req.body?.notificationIds);

    if (!targetId) {
      return res.status(400).json({ success: false, error: "Notification ID is required" });
    }

    const notification = await Notification.findOne({ _id: targetId, userId });
    if (!notification) {
      return res.status(404).json({ success: false, error: "Notification not found" });
    }

    if (!notification.read) {
      notification.read = true;
      notification.readAt = new Date();
      await notification.save();

      // Decrement unreadNotificationCount on User document safely
      const user = await User.findById(userId).select("unreadNotificationCount");
      const currentCount = user?.unreadNotificationCount || 0;
      if (currentCount > 0) {
        await User.findByIdAndUpdate(userId, { $inc: { unreadNotificationCount: -1 } }).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, notification });
  } catch (err) {
    console.error("Error marking notification read:", err);
    return res.status(500).json({ success: false, error: "Failed to mark notification read" });
  }
};

// 4. Mark All Notifications as Read
exports.markAllAsRead = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });

    await Notification.updateMany(
      { userId, read: false },
      { $set: { read: true, readAt: new Date() } }
    );

    // Reset unreadNotificationCount to 0
    await User.findByIdAndUpdate(userId, { $set: { unreadNotificationCount: 0 } }).catch(() => {});

    return res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (err) {
    console.error("Error marking all read:", err);
    return res.status(500).json({ success: false, error: "Failed to mark all read" });
  }
};

// 5. Get User Notification Preferences
exports.getPreferences = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });

    let preferences = await NotificationPreference.findOne({ userId });

    if (!preferences) {
      preferences = await NotificationPreference.create({ userId });
    }

    return res.status(200).json({ success: true, preferences });
  } catch (err) {
    console.error("Error fetching preferences:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch preferences" });
  }
};

// 6. Update User Notification Preferences
exports.updatePreferences = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });

    const updates = req.body;

    const preferences = await NotificationPreference.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, upsert: true }
    );

    return res.status(200).json({ success: true, preferences });
  } catch (err) {
    console.error("Error updating preferences:", err);
    return res.status(500).json({ success: false, error: "Failed to update preferences" });
  }
};

// 7. Get User Intelligence Schedules (with Health Observability Info)
exports.getSchedules = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: "User authentication required" });

    const schedules = await IntelligenceSchedule.find({ userId }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, schedules });
  } catch (err) {
    console.error("Error fetching schedules:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch schedules" });
  }
};

// 8. Create Intelligence Schedule (with Automatic Topic/Source Resolution & Semantic Duplicate Check)
const normalizeRateString = (r, type) => {
  const val = (r || type || "daily").toString().toLowerCase().trim();
  if (val === "one_time" || val === "onetime" || val === "one-time") return "one_time";
  return val;
};

// 8. Create Intelligence Schedule (with Automatic Topic/Source Resolution & Semantic Duplicate Check)
exports.createSchedule = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "User authentication required" });

    const { prompt, userQuery, scheduledTime, deliveryTime, timezone, title, rate, sourceConfig } = req.body;

    const rawInput = prompt || userQuery;
    if (!rawInput || !rawInput.trim()) {
      return res.status(400).json({ error: "Topic prompt is required" });
    }

    const rawPrompt = rawInput.trim();
    const timeStr = scheduledTime || deliveryTime || "08:30";
    const userTz = timezone || "Asia/Kolkata";
    const backendRate = normalizeRateString(rate, sourceConfig?.scheduleType);

    // Step 1: Automatic Topic & Source Resolution
    const normalizedTopic = normalizeTopic(rawPrompt);
    const sourceType = resolveSourceType(rawPrompt);
    const scheduleTitle = title || (rawPrompt.length > 30 ? `${rawPrompt.substring(0, 27)}...` : rawPrompt);

    // Step 2: Semantic Duplicate Check
    const existing = await IntelligenceSchedule.findOne({
      userId,
      normalizedTopic,
      enabled: true,
    });

    if (existing) {
      return res.status(409).json({
        error: `An equivalent schedule ("${existing.title}") is already active for this topic.`,
        isDuplicate: true,
        existingSchedule: existing,
      });
    }

    // Step 3: Calculate Dual Timestamps (nextRunAt & nextGenerateAt)
    const timestamps = calculateScheduleTimestamps(timeStr, userTz, {
      rate: backendRate,
      startDate: sourceConfig?.startDate,
      weeklyDays: sourceConfig?.weeklyDays,
      monthlyRunOn: sourceConfig?.monthlyRunOn,
      customInterval: sourceConfig?.customInterval,
      customUnit: sourceConfig?.customUnit,
      fromDate: new Date(),
    });

    const schedule = await IntelligenceSchedule.create({
      userId,
      title: scheduleTitle,
      rawPrompt,
      userQuery: rawPrompt,
      normalizedTopic,
      sourceType,
      timezone: userTz,
      scheduledTime: timeStr,
      rate: backendRate,
      sourceConfig: sourceConfig || {},
      nextRunAt: timestamps.nextRunAt,
      nextGenerateAt: timestamps.nextGenerateAt,
      generationStatus: "pending",
      enabled: true,
      autoPaused: false,
    });

    console.log("📌 [SCHEDULE CREATED]", JSON.stringify({
      scheduleId: schedule._id,
      userId,
      title: scheduleTitle,
      rate: backendRate,
      scheduledTime: timeStr,
      timezone: userTz,
      nextRunAt: timestamps.nextRunAt,
      nextGenerateAt: timestamps.nextGenerateAt,
    }));

    return res.status(201).json({ success: true, schedule });
  } catch (err) {
    console.error("Error creating schedule:", err);
    return res.status(500).json({ error: "Failed to create schedule" });
  }
};

// 9. Update Intelligence Schedule (Immediately Recalculates & Reschedules)
exports.updateSchedule = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "User authentication required" });

    const { id } = req.params;
    const { enabled, scheduledTime, deliveryTime, timezone, prompt, userQuery, rate, sourceConfig, title } = req.body;

    const schedule = await IntelligenceSchedule.findOne({ _id: id, userId });
    if (!schedule) {
      return res.status(404).json({ error: "Schedule not found" });
    }

    const newTime = scheduledTime || deliveryTime;
    const newPrompt = prompt || userQuery;

    if (enabled !== undefined) schedule.enabled = Boolean(enabled);
    if (newTime) schedule.scheduledTime = newTime;
    if (timezone) schedule.timezone = timezone;
    if (title) schedule.title = title;
    if (sourceConfig) schedule.sourceConfig = { ...(schedule.sourceConfig || {}), ...sourceConfig };

    const backendRate = normalizeRateString(rate || schedule.rate, schedule.sourceConfig?.scheduleType);
    schedule.rate = backendRate;

    if (newPrompt && newPrompt.trim()) {
      schedule.rawPrompt = newPrompt.trim();
      schedule.userQuery = newPrompt.trim();
      schedule.title = title || (newPrompt.trim().length > 30 ? `${newPrompt.trim().substring(0, 27)}...` : newPrompt.trim());
      schedule.normalizedTopic = normalizeTopic(newPrompt.trim());
      schedule.sourceType = resolveSourceType(newPrompt.trim());
    }

    // Recalculate precision timestamps immediately with updated options
    const timestamps = calculateScheduleTimestamps(schedule.scheduledTime, schedule.timezone, {
      rate: backendRate,
      startDate: schedule.sourceConfig?.startDate,
      weeklyDays: schedule.sourceConfig?.weeklyDays,
      monthlyRunOn: schedule.sourceConfig?.monthlyRunOn,
      customInterval: schedule.sourceConfig?.customInterval,
      customUnit: schedule.sourceConfig?.customUnit,
      fromDate: new Date(),
    });

    schedule.nextRunAt = timestamps.nextRunAt;
    schedule.nextGenerateAt = timestamps.nextGenerateAt;
    schedule.generationStatus = "pending";
    schedule.failureCount = 0;
    schedule.lastError = "";
    if (enabled === true) schedule.autoPaused = false; // Reactivate if re-enabled

    await schedule.save();

    console.log("✏️ [SCHEDULE UPDATED / RESCHEDULED]", JSON.stringify({
      scheduleId: schedule._id,
      userId,
      title: schedule.title,
      rate: backendRate,
      scheduledTime: schedule.scheduledTime,
      timezone: schedule.timezone,
      nextRunAt: timestamps.nextRunAt,
      nextGenerateAt: timestamps.nextGenerateAt,
      enabled: schedule.enabled,
    }));

    return res.status(200).json({ success: true, schedule });
  } catch (err) {
    console.error("Error updating schedule:", err);
    return res.status(500).json({ error: "Failed to update schedule" });
  }
};

// 10. Delete / Disable Schedule
exports.deleteSchedule = async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "User authentication required" });

    const { id } = req.params;

    await IntelligenceSchedule.deleteOne({ _id: id, userId });

    console.log("🗑️ [SCHEDULE DELETED]", JSON.stringify({
      scheduleId: id,
      userId,
    }));

    return res.status(200).json({ success: true, message: "Schedule deleted successfully" });
  } catch (err) {
    console.error("Error deleting schedule:", err);
    return res.status(500).json({ error: "Failed to delete schedule" });
  }
};
