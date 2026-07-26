import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachePath,
  checkWritableDir,
  clearCache,
  formatUTCDate,
  loadPapers,
  mergePapers,
  savePapers,
  writeDigest,
} from "./store.js";
import type { Paper } from "./types.js";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    abstract: "abstract",
    link: `https://arxiv.org/abs/${id}`,
    authors: [],
    categories: ["cs.CV"],
    published: "2026-01-05T14:00:00Z",
    journalRef: null,
    comment: null,
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paperino-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatUTCDate", () => {
  it("formats a UTC instant as YYYY-MM-DD", () => {
    expect(formatUTCDate(new Date(Date.UTC(2026, 0, 5, 14, 0, 0)))).toBe("2026-01-05");
  });
});

describe("checkWritableDir", () => {
  it("accepts a deep chain of missing dirs and creates it", () => {
    const target = join(dir, "a", "b", "c", "d");
    expect(checkWritableDir(target)).toBeNull();
    expect(existsSync(target)).toBe(true);
  });

  it("accepts a dir that already exists", () => {
    expect(checkWritableDir(dir)).toBeNull();
  });

  it("reports a file sitting in the middle of the path", () => {
    writeFileSync(join(dir, "afile"), "x");
    expect(checkWritableDir(join(dir, "afile", "digests"))).toMatch(/file is in the way/);
  });

  it("reports the target path itself being a file", () => {
    writeFileSync(join(dir, "afile"), "x");
    expect(checkWritableDir(join(dir, "afile"))).toMatch(/file is in the way/);
  });

  it("reports an unwritable parent", () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      expect(checkWritableDir(join(locked, "sub"))).toMatch(/permission denied/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("reports an existing dir that can't be written into (mkdir alone would pass)", () => {
    const ro = join(dir, "readonly");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(checkWritableDir(ro)).toMatch(/permission denied/);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it("leaves no probe file behind on success", () => {
    checkWritableDir(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("cachePath", () => {
  it("is a flat file named by the window-end UTC date", () => {
    const out = cachePath(dir, new Date(Date.UTC(2026, 0, 5, 14, 0, 0)));
    expect(out).toBe(join(dir, "2026-01-05.json"));
  });
});

describe("clearCache", () => {
  it("removes only the given window's cache file", () => {
    const target = new Date(Date.UTC(2026, 0, 5, 14, 0, 0));
    const other = new Date(Date.UTC(2026, 0, 6, 14, 0, 0));
    savePapers(cachePath(dir, target), [paper("a")]);
    savePapers(cachePath(dir, other), [paper("b")]);

    clearCache(dir, target);

    expect(loadPapers(cachePath(dir, target))).toEqual([]);
    expect(loadPapers(cachePath(dir, other))).toHaveLength(1);
  });

  it("is a no-op when the window was never cached", () => {
    expect(() => clearCache(dir, new Date())).not.toThrow();
  });
});

describe("mergePapers", () => {
  it("keys by id, preserves existing coarse/score, unions fetch-dropped records", () => {
    const existing = [paper("a", { coarse: 1, score: 8 }), paper("b", { coarse: 0 })];
    const fetched = [paper("a", { title: "stale refetch title" }), paper("c")];

    const merged = mergePapers(existing, fetched);

    expect(merged).toHaveLength(3); // a, b (kept even though not refetched), c (new)
    const byId = Object.fromEntries(merged.map((p) => [p.id, p]));
    expect(byId.a.coarse).toBe(1);
    expect(byId.a.score).toBe(8);
    expect(byId.a.title).toBe("Title a"); // existing record wins, not overwritten by fetch
    expect(byId.b.coarse).toBe(0);
    expect(byId.c).toBeDefined();
  });
});

describe("loadPapers/savePapers", () => {
  it("writes the cache file even for an empty window", () => {
    const path = cachePath(dir, new Date());
    savePapers(path, []);
    expect(loadPapers(path)).toEqual([]);
  });

  it("round-trips papers through JSON", () => {
    const path = cachePath(dir, new Date());
    const papers = [paper("a", { coarse: 1, score: 7 })];
    savePapers(path, papers);
    expect(loadPapers(path)).toEqual(papers);
  });

  it("returns an empty array when the cache file doesn't exist yet", () => {
    expect(loadPapers(cachePath(dir, new Date()))).toEqual([]);
  });

  it("creates the cache dir if it doesn't exist yet", () => {
    const path = cachePath(join(dir, "nested", "cache"), new Date());
    savePapers(path, [paper("a")]);
    expect(loadPapers(path)).toHaveLength(1);
  });
});

describe("writeDigest", () => {
  it("writes a flat YYYY-MM-DD.html named by the window end", () => {
    const path = writeDigest(dir, new Date(Date.UTC(2026, 0, 5, 14, 0, 0)), "<p>hello</p>");
    expect(path).toBe(join(dir, "2026-01-05.html"));
    expect(readFileSync(path, "utf-8")).toBe("<p>hello</p>");
  });

  it("creates the output dir if it doesn't exist yet", () => {
    const outDir = join(dir, "nested", "digests");
    const path = writeDigest(outDir, new Date(Date.UTC(2026, 0, 5, 14, 0, 0)), "<p>hi</p>");
    expect(path).toBe(join(outDir, "2026-01-05.html"));
  });
});
