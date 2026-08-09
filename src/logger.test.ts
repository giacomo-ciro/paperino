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
    logger.announcementStart("2026-01-05");
    logger.stageStart("Coarse filtering");
    logger.detail("page start=0 requested (attempt 1/3)");
    logger.detail("call 3/3 failed after 2 attempts, 20 papers kept: claude exited with code 1");
    logger.stageEnd("Coarse filtering", "42/42 papers processed (10/42 papers kept, 3/3 calls done, 1 failed)");
    logger.stageFailed("Sending email", "Error: connect ECONNREFUSED 127.0.0.1:587");
    logger.announcementEnd("2026-01-05", 12_300);
    logger.pipelineEnd(1);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(9);
    expect(lines[0]).toMatch(/^\[.+\] pipeline started \(2 announcements to process\)$/);
    expect(lines[1]).toMatch(/^\[.+\] processing announcement 2026-01-05$/);
    expect(lines[2]).toMatch(/^\[.+\]\s{3}Coarse filtering started$/);
    expect(lines[3]).toMatch(/^\[.+\]\s{5}page start=0 requested \(attempt 1\/3\)$/);
    expect(lines[4]).toMatch(
      /^\[.+\]\s{5}call 3\/3 failed after 2 attempts, 20 papers kept: claude exited with code 1$/,
    );
    expect(lines[5]).toMatch(
      /^\[.+\]\s{3}Coarse filtering finished: 42\/42 papers processed \(10\/42 papers kept, 3\/3 calls done, 1 failed\)$/,
    );
    expect(lines[6]).toMatch(/^\[.+\]\s{3}Sending email failed: Error: connect ECONNREFUSED 127\.0\.0\.1:587$/);
    expect(lines[7]).toMatch(/^\[.+\] announcement 2026-01-05 finished in 12\.3s$/);
    expect(lines[8]).toMatch(/^\[.+\] pipeline finished with 1 failed call$/);
  });

  it("pluralises the announcement and failed-call counts", () => {
    const logger = makeLogger(logPath);

    logger.pipelineStart(1);
    logger.pipelineEnd(0);
    logger.pipelineStart(2);
    logger.pipelineEnd(3);
    logger.pipelineAborted();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines[0]).toMatch(/\] pipeline started \(1 announcement to process\)$/);
    expect(lines[1]).toMatch(/\] pipeline finished$/);
    expect(lines[2]).toMatch(/\] pipeline started \(2 announcements to process\)$/);
    expect(lines[3]).toMatch(/\] pipeline finished with 3 failed calls$/);
    expect(lines[4]).toMatch(/\] pipeline aborted$/);
  });

  it("appends across separate makeLogger calls rather than truncating", () => {
    makeLogger(logPath).pipelineStart(1);
    makeLogger(logPath).pipelineEnd(0);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
