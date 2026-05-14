// Recurrence expansion: given a task, produce one master_checklist row per
// scheduled occurrence between start_date and end_date (or start + 1 year).
// All math is timezone-naive (date-only); we treat dates as YYYY-MM-DD.
//
// Occurrences are clamped to the configured financial year window (FY_START
// to FY_END) — dates outside this window are never emitted, regardless of
// the task's start_date or end_date.

const { addDays, addMonths, parseISO, format, getDay, getDate } = require('date-fns');

// Financial year window — override via env vars if needed.
const FY_START = process.env.FY_START || '2026-04-01';
const FY_END   = process.env.FY_END   || '2027-03-31';

function toIso(d) { return format(d, 'yyyy-MM-dd'); }

function daysInMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0).getDate();
}

function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const first = new Date(year, monthIdx, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  if (day > daysInMonth(year, monthIdx)) return null;
  return new Date(year, monthIdx, day);
}

function lastWeekdayOfMonth(year, monthIdx, weekday) {
  const lastDay = daysInMonth(year, monthIdx);
  const last = new Date(year, monthIdx, lastDay);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, monthIdx, lastDay - offset);
}

function generateOccurrences(task, opts = {}) {
  // opts.rangeFrom / opts.rangeTo (YYYY-MM-DD) clip the output window without
  // affecting the recurrence anchor (start_date is still the math reference).
  const { task_id, doer_email, frequency } = task;
  const start = parseISO(task.start_date);
  const end = task.end_date
    ? parseISO(task.end_date)
    : (opts.rangeTo ? parseISO(opts.rangeTo) : addMonths(start, 12));
  const dates = [];

  switch (frequency) {
    case 'D': {
      for (let d = start; d <= end; d = addDays(d, 1)) dates.push(toIso(d));
      break;
    }
    case 'W': {
      for (let d = start; d <= end; d = addDays(d, 7)) dates.push(toIso(d));
      break;
    }
    case 'F': {
      for (let d = start; d <= end; d = addDays(d, 14)) dates.push(toIso(d));
      break;
    }
    case 'M':
    case 'Q':
    case 'Y': {
      const step = frequency === 'M' ? 1 : frequency === 'Q' ? 3 : 12;
      const targetDay = getDate(start);
      let cur = start;
      while (cur <= end) {
        const dim = daysInMonth(cur.getFullYear(), cur.getMonth());
        const day = Math.min(targetDay, dim);
        const planned = new Date(cur.getFullYear(), cur.getMonth(), day);
        if (planned >= start && planned <= end) dates.push(toIso(planned));
        cur = addMonths(cur, step);
      }
      break;
    }
    case 'SM': {
      let cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        for (const day of [1, 15]) {
          const planned = new Date(cur.getFullYear(), cur.getMonth(), day);
          if (planned >= start && planned <= end) dates.push(toIso(planned));
        }
        cur = addMonths(cur, 1);
      }
      break;
    }
    case 'E1ST':
    case 'E2ND':
    case 'E3RD':
    case 'E4TH': {
      const n = { E1ST: 1, E2ND: 2, E3RD: 3, E4TH: 4 }[frequency];
      const weekday = getDay(start);
      let cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const planned = nthWeekdayOfMonth(cur.getFullYear(), cur.getMonth(), weekday, n);
        if (planned && planned >= start && planned <= end) dates.push(toIso(planned));
        cur = addMonths(cur, 1);
      }
      break;
    }
    case 'ELAST': {
      const weekday = getDay(start);
      let cur = new Date(start.getFullYear(), start.getMonth(), 1);
      while (cur <= end) {
        const planned = lastWeekdayOfMonth(cur.getFullYear(), cur.getMonth(), weekday);
        if (planned >= start && planned <= end) dates.push(toIso(planned));
        cur = addMonths(cur, 1);
      }
      break;
    }
    default:
      throw new Error(`Unsupported frequency: ${frequency}`);
  }

  let filtered = dates;
  if (opts.rangeFrom) filtered = filtered.filter(d => d >= opts.rangeFrom);
  if (opts.rangeTo)   filtered = filtered.filter(d => d <= opts.rangeTo);
  // Hard clamp to financial year — applied AFTER any caller-supplied range.
  filtered = filtered.filter(d => d >= FY_START && d <= FY_END);

  return filtered.map(planned_date => ({
    occurrence_key: `${task_id}_${planned_date}`,
    task_id,
    doer_email,
    planned_date,
    freq: frequency,
    status: 'Scheduled',
  }));
}

module.exports = { generateOccurrences, FY_START, FY_END };
