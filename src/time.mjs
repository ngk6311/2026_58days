function formatParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

export function zonedDateKey(date, timeZone, scoreResetHour = 0) {
  const parts = formatParts(date, timeZone);
  const shifted = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) - scoreResetHour,
      Number(parts.minute),
      Number(parts.second),
    ),
  );
  return shifted.toISOString().slice(0, 10);
}

export function formatDateTime(date, timeZone) {
  const parts = formatParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function todayKey(timeZone, scoreResetHour = 0) {
  return zonedDateKey(new Date(), timeZone, scoreResetHour);
}

export function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function enumerateDateKeys(endDateKey, totalDays) {
  const keys = [];
  for (let i = totalDays - 1; i >= 0; i -= 1) {
    keys.push(addDays(endDateKey, -i));
  }
  return keys;
}

export function weekStartKey(dateKey, weekStart = 1) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const day = date.getUTCDay();
  const normalized = (day - weekStart + 7) % 7;
  date.setUTCDate(date.getUTCDate() - normalized);
  return date.toISOString().slice(0, 10);
}
