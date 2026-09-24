const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");
const authMiddleware = require("../middleware/auth");

const protect = typeof authMiddleware === "function" ? authMiddleware : authMiddleware.protect;

router.use(protect);

// Notifications list & unread count
router.get("/", notificationController.getNotifications);
router.get("/unread-count", notificationController.getUnreadCount);
router.patch("/read", notificationController.markAsRead);
router.patch("/:id/read", notificationController.markAsRead);
router.patch("/read-all", notificationController.markAllAsRead);

// User preferences
router.get("/preferences", notificationController.getPreferences);
router.put("/preferences", notificationController.updatePreferences);

// Schedules CRUD
router.get("/schedules", notificationController.getSchedules);
router.post("/schedules", notificationController.createSchedule);
router.put("/schedules/:id", notificationController.updateSchedule);
router.delete("/schedules/:id", notificationController.deleteSchedule);

module.exports = router;
