import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCachedUpdate } from "./update-check.js";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paperino-update-check-test-"));
  cachePath = join(dir, "update-check.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCachedUpdate", () => {
  it("returns undefined when no cache file exists", () => {
    expect(readCachedUpdate("0.1.7", cachePath)).toBeUndefined();
  });

  it("returns undefined when cache file is corrupt", () => {
    writeFileSync(cachePath, "not json");
    expect(readCachedUpdate("0.1.7", cachePath)).toBeUndefined();
  });

  it("returns the latest version when it is newer than current", () => {
    writeFileSync(cachePath, JSON.stringify({ latestVersion: "0.2.0", checkedAt: new Date().toISOString() }));
    expect(readCachedUpdate("0.1.7", cachePath)).toBe("0.2.0");
  });

  it("returns undefined when cached version is the same as current", () => {
    writeFileSync(cachePath, JSON.stringify({ latestVersion: "0.1.7", checkedAt: new Date().toISOString() }));
    expect(readCachedUpdate("0.1.7", cachePath)).toBeUndefined();
  });

  it("returns undefined when cached version is older than current", () => {
    writeFileSync(cachePath, JSON.stringify({ latestVersion: "0.1.6", checkedAt: new Date().toISOString() }));
    expect(readCachedUpdate("0.1.7", cachePath)).toBeUndefined();
  });

  it("compares multi-digit version segments numerically, not lexically", () => {
    writeFileSync(cachePath, JSON.stringify({ latestVersion: "0.10.0", checkedAt: new Date().toISOString() }));
    expect(readCachedUpdate("0.9.0", cachePath)).toBe("0.10.0");
  });
});
