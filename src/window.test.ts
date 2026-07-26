import { describe, expect, it } from "vitest";
import { announcementsToProcess, latestAnnouncement, submissionWindow } from "./window.js";

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

describe("latestAnnouncement", () => {
  it("labels Friday's cutoff as the Sunday announcement", () => {
    const announcement = latestAnnouncement(et("2026-01-11T21:00:00"));
    expect(utcLabel(announcement.announcedAt)).toBe(utcLabel(et("2026-01-11T20:00:00")));
    expect(utcLabel(announcement.submittedUntil)).toBe(utcLabel(et("2026-01-09T14:00:00")));
  });

  it("labels weekday cutoffs as same-day announcements", () => {
    const announcement = latestAnnouncement(et("2026-01-06T21:00:00"));
    expect(utcLabel(announcement.announcedAt)).toBe(utcLabel(et("2026-01-06T20:00:00")));
  });
});

describe("announcementsToProcess", () => {
  it("returns only the latest announcement when count is 1", () => {
    const now = et("2026-01-12T21:00:00");
    const announcements = announcementsToProcess(now, 1);
    expect(announcements).toEqual([latestAnnouncement(now)]);
  });

  it("returns the latest N announcements oldest-first", () => {
    const announcements = announcementsToProcess(et("2026-01-12T21:00:00"), 3);
    expect(announcements.map((a) => utcLabel(a.announcedAt))).toEqual([
      utcLabel(et("2026-01-08T20:00:00")),
      utcLabel(et("2026-01-11T20:00:00")),
      utcLabel(et("2026-01-12T20:00:00")),
    ]);
  });

  it("returns distinct, contiguous submission periods", () => {
    const announcements = announcementsToProcess(et("2026-01-12T21:00:00"), 5);
    expect(announcements).toHaveLength(5);
    for (let i = 1; i < announcements.length; i++) {
      expect(announcements[i].announcedAt.getTime()).toBeGreaterThan(
        announcements[i - 1].announcedAt.getTime(),
      );
      expect(announcements[i].submittedFrom.getTime()).toBe(
        announcements[i - 1].submittedUntil.getTime(),
      );
    }
  });
});
