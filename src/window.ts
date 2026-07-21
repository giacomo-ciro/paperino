const ET_TIME_ZONE = "America/New_York";
const CUTOFF_HOUR = 14; // arXiv's daily submission-window cutoff, ET

/** A wall-clock moment in some timezone, with no attached offset. */
interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Convert a UTC instant to its ET wall-clock parts. */
function utcToEtWallClock(instant: Date): WallClock {
  const parts = etFormatter.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Convert ET wall-clock parts to the UTC instant they represent.
 * Uses the offset-via-two-formatters trick: guess UTC == the wall-clock parts
 * verbatim, see how far that guess's ET rendering drifts, and correct for it.
 * One correction pass is sufficient since ET offsets only take integer-hour values.
 */
function etWallClockToUtc(wall: WallClock): Date {
  const guessMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const guess = new Date(guessMs);
  const guessAsEt = utcToEtWallClock(guess);
  const guessAsEtMs = Date.UTC(
    guessAsEt.year,
    guessAsEt.month - 1,
    guessAsEt.day,
    guessAsEt.hour,
    guessAsEt.minute,
    guessAsEt.second,
  );
  const driftMs = guessAsEtMs - guessMs;
  return new Date(guessMs - driftMs);
}

/** Weekday of a wall-clock date, Mon=0 ... Sun=6 (matches Python's `date.weekday()`). */
function weekday(wall: WallClock): number {
  const jsDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay(); // Sun=0 ... Sat=6
  return (jsDay + 6) % 7;
}

/** Add (or subtract, for negative n) whole calendar days to a wall-clock moment. */
function addDays(wall: WallClock, n: number): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  d.setUTCDate(d.getUTCDate() + n);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
}

function atCutoff(wall: WallClock): WallClock {
  return { ...wall, hour: CUTOFF_HOUR, minute: 0, second: 0 };
}

function addHours(wall: WallClock, hours: number): WallClock {
  const totalMinutes = wall.hour * 60 + wall.minute + hours * 60;
  const dayOffset = Math.floor(totalMinutes / (24 * 60));
  const minutesInDay = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const withTime = addDays(wall, dayOffset);
  return {
    ...withTime,
    hour: Math.floor(minutesInDay / 60),
    minute: minutesInDay % 60,
    second: wall.second,
  };
}

function compareWallClock(a: WallClock, b: WallClock): number {
  const aMs = Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute, a.second);
  const bMs = Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute, b.second);
  return aMs - bMs;
}

/**
 * Find the most recent submission window already announced, as of `now`.
 *
 * arXiv's daily submission-window cutoff is 14:00 ET; results are announced 20:00 ET
 * the same day, except Friday's cutoff (which covers the whole weekend) is announced
 * the following Sunday 20:00. Sat/Sun are never a window's end. A window ending on
 * Monday spans 3 days (it absorbs the weekend); every other window spans 1 day.
 *
 * Returns [start, end] as UTC Dates.
 */
export function submissionWindow(now: Date): [Date, Date] {
  const nowEt = utcToEtWallClock(now);
  let windowEnd = atCutoff(nowEt);

  // if now is earlier than 14:00 ET, cutoff occurred yesterday
  if (compareWallClock(nowEt, windowEnd) < 0) {
    windowEnd = addDays(windowEnd, -1);
  }

  for (;;) {
    const wd = weekday(windowEnd); // Mon=0 ... Sun=6

    // Sat/Sun: not a real cutoff, walk back to Friday
    if (wd === 5 || wd === 6) {
      windowEnd = addDays(windowEnd, -1);
      continue;
    }

    const announcedAt = wd === 4 ? addHours(addDays(windowEnd, 2), 6) : addHours(windowEnd, 6);

    if (compareWallClock(nowEt, announcedAt) >= 0) {
      break;
    }
    windowEnd = addDays(windowEnd, -1);
  }

  // window ending on Monday spans 3 days (absorbs the weekend), else 1 day
  const daysBack = weekday(windowEnd) === 0 ? 3 : 1;
  const windowStart = addDays(windowEnd, -daysBack);

  return [etWallClockToUtc(windowStart), etWallClockToUtc(windowEnd)];
}

/**
 * Enumerate the windows to process for `--start-from`/`--windows`, both 1-indexed.
 * Window #1 is the latest announced window, #2 the one before it, etc.
 * `startFrom` anchors backward in time; `limit` walks forward (toward more recent)
 * from the anchor, clamped at #1 (never into the future).
 *
 * Returns windows oldest-first.
 */
export function windowsToProcess(now: Date, startFrom: number, limit: number): [Date, Date][] {
  // newest index actually wanted: startFrom walking forward (limit-1) steps, clamped at #1
  const newestIndex = Math.max(1, startFrom - (limit - 1));

  const windows: [Date, Date][] = [];
  let [start, end] = submissionWindow(now);
  for (let index = 1; index <= startFrom; index++) {
    if (index >= newestIndex) {
      windows.push([start, end]);
    }
    [start, end] = submissionWindow(new Date(start.getTime() - 1));
  }

  return windows.reverse(); // oldest-first
}
