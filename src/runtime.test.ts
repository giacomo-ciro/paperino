import { describe, expect, it } from "vitest";
import { formatRuntime } from "./runtime.js";

describe("formatRuntime", () => {
  it("always keeps one decimal so animated runtimes do not visually collapse", () => {
    expect(formatRuntime(1_900)).toBe("1.9s");
    expect(formatRuntime(2_000)).toBe("2.0s");
    expect(formatRuntime(2_100)).toBe("2.1s");
    expect(formatRuntime(10_000)).toBe("10.0s");
    expect(formatRuntime(17_300)).toBe("17.3s");
  });

  it("formats minute and hour durations with decimal seconds", () => {
    expect(formatRuntime(60_000)).toBe("1m 00.0s");
    expect(formatRuntime(3_661_000)).toBe("1h 01m 01.0s");
  });
});
