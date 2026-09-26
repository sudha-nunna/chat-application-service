/**
 * timezoneService.js
 * Timezone & Dual-Timestamp Math Helper.
 * Calculates nextRunAt (exact notification time) and nextGenerateAt (nextRunAt - 2 minutes).
 * Supports one_time, daily, weekly, monthly, and custom recurrence modes.
 * Seamlessly handles IANA timezones including Asia/Kolkata and Asia/Calcutta.
 */

/**
 * Converts local (year, month [1-12], day, hour [0-23], minute [0-59]) in target timeZone to exact UTC Date.
 */
function getUtcDateForTzTime(year, month, day, hour, minute, timeZone) {
  let tz = timeZone || "Asia/Kolkata";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch (_) {
    tz = "Asia/Kolkata";
  }

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let date = new Date(utcMs);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(date);
    const map = {};
    parts.forEach((p) => {
      map[p.type] = p.value;
    });

    const tzYear = parseInt(map.year, 10);
    const tzMonth = parseInt(map.month, 10);
    const tzDay = parseInt(map.day, 10);
    const tzHour = parseInt(map.hour, 10) % 24;
    const tzMin = parseInt(map.minute, 10);

    const targetDateMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const actualDateMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, 0);
    const diffMs = targetDateMs - actualDateMs;

    if (diffMs === 0) break;
    date = new Date(date.getTime() + diffMs);
  }

  return date;
}

/**
 * Calculates nextRunAt & nextGenerateAt in UTC.
 * @param {string} scheduledTime - "HH:mm" (e.g., "18:30")
 * @param {string} timeZone - IANA string (e.g., "Asia/Kolkata", "Asia/Calcutta")
 * @param {Object|Date} [options={}] - Options object or legacy fromDate
 * @returns {{ nextRunAt: Date, nextGenerateAt: Date }}
 */
function calculateScheduleTimestamps(scheduledTime, timeZone = "Asia/Kolkata", options = {}) {
  let opts = {};
  if (options instanceof Date) {
    opts = { fromDate: options };
  } else if (typeof options === "object" && options !== null) {
    opts = options;
  }

  const [hoursStr, minutesStr] = (scheduledTime || "08:30").split(":");
  const targetHour = parseInt(hoursStr, 10) || 0;
  const targetMinute = parseInt(minutesStr, 10) || 0;

  let tz = timeZone || "Asia/Kolkata";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch (_) {
    tz = "Asia/Kolkata";
  }

  const refDate = opts.fromDate instanceof Date ? opts.fromDate : new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(refDate);
  const nowMap = {};
  parts.forEach((p) => {
    nowMap[p.type] = p.value;
  });

  const curYear = parseInt(nowMap.year, 10);
  const curMonth = parseInt(nowMap.month, 10); // 1-12
  const curDay = parseInt(nowMap.day, 10);
  const curHour = parseInt(nowMap.hour, 10) % 24;
  const curMin = parseInt(nowMap.minute, 10);

  const rate = opts.rate || "daily";
  const isNextCycle = Boolean(opts.isNextCycle);

  let targetYear = curYear;
  let targetMonth = curMonth;
  let targetDay = curDay;

  if (rate === "one_time") {
    // Use explicit startDate when provided; otherwise default to today in the target timezone
    if (opts.startDate && typeof opts.startDate === "string") {
      const cleanDate = opts.startDate.split("T")[0].trim();
      const dateParts = cleanDate.split("-");
      if (dateParts.length === 3) {
        targetYear = parseInt(dateParts[0], 10) || curYear;
        targetMonth = parseInt(dateParts[1], 10) || curMonth;
        targetDay = parseInt(dateParts[2], 10) || curDay;
      }
    }
    // targetYear/Month/Day already defaulted to curYear/curMonth/curDay above — no "tomorrow" advance for one_time
    const nextRunAt = getUtcDateForTzTime(targetYear, targetMonth, targetDay, targetHour, targetMinute, tz);
    const nextGenerateAt = new Date(nextRunAt.getTime() - 2 * 60 * 1000);
    return { nextRunAt, nextGenerateAt };
  }

  // Recurring schedule calculations (daily, weekly, monthly, custom)
  if (isNextCycle) {
    if (rate === "weekly") {
      const weeklyDays = Array.isArray(opts.weeklyDays) ? opts.weeklyDays : [];
      const dayNameMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const currentDayOfWeek = refDate.getDay();
      let daysToAdd = 1;
      if (weeklyDays.length > 0) {
        const targetDayNums = weeklyDays.map((d) => dayNameMap[d]).filter((d) => d !== undefined);
        let foundOffset = null;
        for (let offset = 1; offset <= 7; offset++) {
          const testDay = (currentDayOfWeek + offset) % 7;
          if (targetDayNums.includes(testDay)) {
            foundOffset = offset;
            break;
          }
        }
        daysToAdd = foundOffset || 7;
      } else {
        daysToAdd = 7;
      }
      const nextDate = new Date(refDate.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
      const nParts = formatter.formatToParts(nextDate);
      const nMap = {};
      nParts.forEach((p) => {
        nMap[p.type] = p.value;
      });
      targetYear = parseInt(nMap.year, 10);
      targetMonth = parseInt(nMap.month, 10);
      targetDay = parseInt(nMap.day, 10);
    } else if (rate === "monthly") {
      if (targetMonth === 12) {
        targetYear += 1;
        targetMonth = 1;
      } else {
        targetMonth += 1;
      }
      if (opts.monthlyRunOn === "15th") targetDay = 15;
      else if (opts.monthlyRunOn === "last_day") {
        targetDay = new Date(targetYear, targetMonth, 0).getDate();
      } else targetDay = 1;
    } else if (rate === "custom") {
      const interval = parseInt(opts.customInterval, 10) || 1;
      const unit = (opts.customUnit || "Days").toLowerCase();
      let msToAdd = interval * 24 * 60 * 60 * 1000;
      if (unit.startsWith("hour")) msToAdd = interval * 60 * 60 * 1000;
      if (unit.startsWith("minute")) msToAdd = interval * 60 * 1000;
      if (unit.startsWith("week")) msToAdd = interval * 7 * 24 * 60 * 60 * 1000;

      const nextDate = new Date(refDate.getTime() + msToAdd);
      const nParts = formatter.formatToParts(nextDate);
      const nMap = {};
      nParts.forEach((p) => {
        nMap[p.type] = p.value;
      });
      targetYear = parseInt(nMap.year, 10);
      targetMonth = parseInt(nMap.month, 10);
      targetDay = parseInt(nMap.day, 10);
    } else {
      // Default daily: advance to tomorrow
      const tomorrow = new Date(refDate.getTime() + 24 * 60 * 60 * 1000);
      const tParts = formatter.formatToParts(tomorrow);
      const tMap = {};
      tParts.forEach((p) => {
        tMap[p.type] = p.value;
      });
      targetYear = parseInt(tMap.year, 10);
      targetMonth = parseInt(tMap.month, 10);
      targetDay = parseInt(tMap.day, 10);
    }
  } else {
    // Initial creation or edit calculation: check if target time today has passed
    if (curHour > targetHour || (curHour === targetHour && curMin >= targetMinute)) {
      const tomorrow = new Date(refDate.getTime() + 24 * 60 * 60 * 1000);
      const tParts = formatter.formatToParts(tomorrow);
      const tMap = {};
      tParts.forEach((p) => {
        tMap[p.type] = p.value;
      });
      targetYear = parseInt(tMap.year, 10);
      targetMonth = parseInt(tMap.month, 10);
      targetDay = parseInt(tMap.day, 10);
    }
  }

  const nextRunAt = getUtcDateForTzTime(targetYear, targetMonth, targetDay, targetHour, targetMinute, tz);
  const nextGenerateAt = new Date(nextRunAt.getTime() - 2 * 60 * 1000);

  return { nextRunAt, nextGenerateAt };
}

module.exports = {
  calculateScheduleTimestamps,
  getUtcDateForTzTime,
};
