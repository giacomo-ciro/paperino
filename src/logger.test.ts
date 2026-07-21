import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeLogger } from "./logger.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paperino-logger-test-"));
  logPath = join(dir, "nested", "paperino.log"); // nested: exercises the mkdir -p
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("makeLogger", () => {
  it("creates the log dir if missing", () => {
    makeLogger(logPath);
    expect(existsSync(logPath)).toBe(true);
  });

  it("appends one timestamped line per event, in call order", () => {
    const logger = makeLogger(logPath);

    logger.pipelineStart(2);
    logger.windowStart("2026-01-05");
    logger.stageStart("Coarse filtering");
    logger.callFailed("Coarse filtering", "claude exited with code 1: boom");
    logger.stageEnd("Coarse filtering", "42/42 papers processed (10/42 papers kept, 3/3 calls done, 1 failed)");
    logger.pipelineEnd();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^\[.+\] pipeline started \(2 window\(s\) to process\)$/);
    expect(lines[1]).toMatch(/^\[.+\] processing window 2026-01-05$/);
    expect(lines[2]).toMatch(/^\[.+\]\s{3}stage started: Coarse filtering$/);
    expect(lines[3]).toMatch(/^\[.+\]\s{3}call failed: Coarse filtering — claude exited with code 1: boom$/);
    expect(lines[4]).toMatch(
      /^\[.+\]\s{3}stage finished: Coarse filtering — 42\/42 papers processed \(10\/42 papers kept, 3\/3 calls done, 1 failed\)$/,
    );
    expect(lines[5]).toMatch(/^\[.+\] pipeline finished$/);
  });

  it("appends across separate makeLogger calls rather than truncating", () => {
    makeLogger(logPath).pipelineStart(1);
    makeLogger(logPath).pipelineEnd();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
