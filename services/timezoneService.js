/**
 * timezoneService.js
 * Timezone & Dual-Timestamp Math Helper.
 * Calculates nextRunAt (exact notification time) and nextGenerateAt (nextRunAt - 2 minutes).
 */

/**
 * Calculates nextRunAt in UTC given a 24-hr time string (e.g., "09:00") and an IANA timezone (e.g. "Asia/Kolkata").
 * @param {string} scheduledTime - 24-hr format "HH:mm" (e.g., "09:00")
 * @param {string} timeZone - Valid IANA timezone string (e.g., "Asia/Kolkata", "America/New_York")
 * @param {Date} [fromDate=new Date()] - Reference date for calculation
 * @returns {{ nextRunAt: Date, nextGenerateAt: Date }}
 */
function calculateScheduleTimestamps(scheduledTime, timeZone = "Asia/Kolkata", fromDate = new Date()) {
  const [hoursStr, minutesStr] = (scheduledTime || "09:00").split(":");
  const targetHour = parseInt(hoursStr, 10) || 9;
  const targetMinute = parseInt(minutesStr, 10) || 0;

  let targetTz = timeZone;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: targetTz });
  } catch (_) {
    targetTz = "Asia/Kolkata";
  }

  // Get current date components in user's target IANA timezone
  const now = fromDate instanceof Date ? fromDate : new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: targetTz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });

  const currentYear = parseInt(map.year, 10);
  const currentMonth = parseInt(map.month, 10) - 1; // 0-indexed
  const currentDay = parseInt(map.day, 10);
  const currentHour = parseInt(map.hour, 10) % 24;
  const currentMin = parseInt(map.minute, 10);

  // Check if target date is today in user's timezone, and if scheduled time has passed
  const realNow = new Date();
  const realParts = formatter.formatToParts(realNow);
  const realMap = {};
  realParts.forEach((p) => { realMap[p.type] = p.value; });

  const isToday = realMap.year === map.year && realMap.month === map.month && realMap.day === map.day;
  let runDay = currentDay;
  if (isToday && (currentHour > targetHour || (currentHour === targetHour && currentMin >= targetMinute))) {
    runDay += 1;
  }

  // Construct target Date object by finding corresponding UTC timestamp
  // Start with a UTC date estimate
  const utcEstimate = Date.UTC(currentYear, currentMonth, runDay, targetHour, targetMinute, 0);
  let nextRunAt = new Date(utcEstimate);

  // Adjust for timezone offset difference
  const checkParts = formatter.formatToParts(nextRunAt);
  const checkMap = {};
  checkParts.forEach((p) => {
    checkMap[p.type] = p.value;
  });

  const checkHour = parseInt(checkMap.hour, 10) % 24;
  const checkMin = parseInt(checkMap.minute, 10);
  
  const diffMinutes = (targetHour - checkHour) * 60 + (targetMinute - checkMin);
  nextRunAt = new Date(nextRunAt.getTime() + diffMinutes * 60 * 1000);

  // Buffer: nextGenerateAt is exactly 2 minutes before nextRunAt
  const nextGenerateAt = new Date(nextRunAt.getTime() - 2 * 60 * 1000);

  return {
    nextRunAt,
    nextGenerateAt,
  };
}

module.exports = {
  calculateScheduleTimestamps,
};
