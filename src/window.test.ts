import { describe, expect, it } from "vitest";
import { submissionWindow, windowsToProcess } from "./window.js";

function et(iso: string): Date {
  // iso is a naive "YYYY-MM-DDTHH:mm:ss" ET wall-clock string; convert via a UTC offset probe.
  const [datePart, timePart] = iso.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  // binary-search-free: try UTC offsets -4 and -5 (EDT/EST), pick whichever round-trips.
  for (const offsetHours of [4, 5]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, ss));
    const rendered = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(guess);
    const get = (t: string) => Number(rendered.find((p) => p.type === t)?.value);
    if (get("year") === y && get("month") === m && get("day") === d && get("hour") === hh && get("minute") === mm) {
      return guess;
    }
  }
  throw new Error(`could not resolve ET wall-clock ${iso}`);
}

function utcLabel(d: Date): string {
  return d.toISOString();
}

describe("submissionWindow", () => {
  it("Monday cutoff -> announced Monday 20:00, window spans 3 days (weekend)", () => {
    // Monday 2026-01-05 15:00 ET is after Monday's 14:00 cutoff but before 20:00 announce,
    // so the announced window should be the *previous* Friday cutoff -> Monday.
    // Pick a time clearly after announcement instead: Tuesday 2026-01-06 08:00 ET.
    const now = et("2026-01-06T08:00:00");
    const [start, end] = submissionWindow(now);
    // window_end should be Monday 2026-01-05 14:00 ET, window_start Friday 2026-01-02 14:00 ET (3 days back)
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-05T14:00:00")));
    expect(utcLabel(start)).toBe(utcLabel(et("2026-01-02T14:00:00")));
  });

  it("Tuesday cutoff -> announced Tuesday 20:00, 1-day span", () => {
    const now = et("2026-01-06T21:00:00"); // Tuesday, after 20:00 announce
    const [start, end] = submissionWindow(now);
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-06T14:00:00")));
    expect(utcLabel(start)).toBe(utcLabel(et("2026-01-05T14:00:00")));
  });

  it("Wednesday cutoff -> announced Wednesday 20:00", () => {
    const now = et("2026-01-07T21:00:00"); // Wednesday
    const [start, end] = submissionWindow(now);
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-07T14:00:00")));
    expect(utcLabel(start)).toBe(utcLabel(et("2026-01-06T14:00:00")));
  });

  it("Thursday cutoff -> announced Thursday 20:00", () => {
    const now = et("2026-01-08T21:00:00"); // Thursday
    const [start, end] = submissionWindow(now);
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-08T14:00:00")));
    expect(utcLabel(start)).toBe(utcLabel(et("2026-01-07T14:00:00")));
  });

  it("Friday cutoff -> announced Sunday 20:00 (held over weekend)", () => {
    const now = et("2026-01-11T21:00:00"); // Sunday, after 20:00 announce
    const [start, end] = submissionWindow(now);
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-09T14:00:00"))); // Friday 14:00 ET
    expect(utcLabel(start)).toBe(utcLabel(et("2026-01-08T14:00:00"))); // Thursday 14:00 ET, 1-day span
  });

  it("pre-20:00 fallback: before today's announcement, falls back to prior window", () => {
    // Tuesday 2026-01-06 10:00 ET: before today's 14:00 cutoff even, so yesterday's cutoff (Monday)
    // hasn't been announced yet either... walk back to the last announced: previous Friday->Monday window
    // announced Monday 20:00 (2026-01-05 20:00), which IS before 2026-01-06 10:00, so that's used.
    const now = et("2026-01-06T10:00:00");
    const [, end] = submissionWindow(now);
    expect(utcLabel(end)).toBe(utcLabel(et("2026-01-05T14:00:00")));
  });

  it("Saturday/Sunday are never a window end", () => {
    const now = et("2026-01-10T12:00:00"); // Saturday
    const [, end] = submissionWindow(now);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(end);
    expect(["Sat", "Sun"]).not.toContain(wd);
  });

  it("is DST-transition safe (March spring-forward weekend)", () => {
    // 2026-03-08 is the US spring-forward Sunday (2:00 AM -> 3:00 AM EDT).
    const now = et("2026-03-09T21:00:00"); // Monday after DST transition
    const [start, end] = submissionWindow(now);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
    // window should still be a clean 3-day Monday span in wall-clock terms
    const spanHours = (end.getTime() - start.getTime()) / 3_600_000;
    expect(spanHours).toBe(3 * 24 - 1); // one hour "lost" to spring-forward
  });
});

describe("windowsToProcess", () => {
  it("defaults (start-from=1, limit=1) return just the latest window", () => {
    const now = new Date();
    const windows = windowsToProcess(now, 1, 1);
    const latest = submissionWindow(now);
    expect(windows).toHaveLength(1);
    expect(utcLabel(windows[0][1])).toBe(utcLabel(latest[1]));
  });

  it("start-from 3, limit 2 returns [#3, #2] oldest-first", () => {
    const now = new Date();
    const windows = windowsToProcess(now, 3, 2);
    expect(windows).toHaveLength(2);

    // recompute #1..#3 by stepping backward
    const w1 = submissionWindow(now);
    const w2 = submissionWindow(new Date(w1[0].getTime() - 1));
    const w3 = submissionWindow(new Date(w2[0].getTime() - 1));

    expect(utcLabel(windows[0][1])).toBe(utcLabel(w3[1])); // oldest first: #3
    expect(utcLabel(windows[1][1])).toBe(utcLabel(w2[1])); // then #2
  });

  it("clamps at #1 when limit would walk past the newest window", () => {
    const now = new Date();
    const windows = windowsToProcess(now, 2, 5);
    expect(windows).toHaveLength(2); // stops at #1, doesn't error

    const w1 = submissionWindow(now);
    const w2 = submissionWindow(new Date(w1[0].getTime() - 1));

    expect(utcLabel(windows[0][1])).toBe(utcLabel(w2[1])); // oldest: #2
    expect(utcLabel(windows[1][1])).toBe(utcLabel(w1[1])); // newest: #1
  });

  it("N calls yield N distinct, strictly-older, gap-free windows", () => {
    const now = new Date();
    const windows = windowsToProcess(now, 5, 5);
    expect(windows).toHaveLength(5);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i][1].getTime()).toBeGreaterThan(windows[i - 1][1].getTime());
      // gap-free: this window's start immediately follows the previous window's end
      expect(windows[i][0].getTime()).toBeGreaterThan(windows[i - 1][1].getTime());
    }
  });
});
