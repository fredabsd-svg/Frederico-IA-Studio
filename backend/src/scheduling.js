const WEEKDAY_INDEX = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

export function resolveScheduleTimeZone(value) {
  const candidate = String(value || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return 'UTC';
  }
}

export function localScheduleParts(date = new Date(), timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveScheduleTimeZone(timeZone),
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    weekday: WEEKDAY_INDEX[parts.weekday]
  };
}

export function scheduleDateKey(date, timeZone) {
  const parts = localScheduleParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function normalizeScheduleDay(cadence, value) {
  const parsed = Number(value);
  if (cadence === 'weekly') {
    return Number.isInteger(parsed) ? Math.min(6, Math.max(0, parsed)) : 0;
  }
  return Number.isInteger(parsed) ? Math.min(31, Math.max(1, parsed)) : 1;
}

export function normalizeScheduleHour(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(23, Math.max(0, parsed)) : 8;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function scheduleDue(schedule, date = new Date(), timeZone) {
  if (!schedule?.enabled) return false;
  const now = localScheduleParts(date, timeZone);
  if (now.hour < normalizeScheduleHour(schedule.hour)) return false;
  if (schedule.last_run === scheduleDateKey(date, timeZone)) return false;
  if (schedule.cadence === 'daily') return true;
  if (schedule.cadence === 'weekly') return now.weekday === normalizeScheduleDay('weekly', schedule.day);
  if (schedule.cadence === 'monthly') {
    const target = Math.min(normalizeScheduleDay('monthly', schedule.day), daysInMonth(now.year, now.month));
    return now.day === target;
  }
  return false;
}
