import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatUTCDate, loadPapers, mergePapers, runDir, savePapers, writeDigest } from "./store.js";
import type { Paper } from "./types.js";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    abstract: "abstract",
    link: `https://arxiv.org/abs/${id}`,
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

describe("runDir", () => {
  it("creates and returns a dir named by the window-end UTC date", () => {
    const out = runDir(dir, new Date(Date.UTC(2026, 0, 5, 14, 0, 0)));
    expect(out).toBe(join(dir, "2026-01-05"));
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
  it("always writes the dir + papers.json, even for an empty window", () => {
    const runDirPath = runDir(dir, new Date());
    savePapers(runDirPath, []);
    expect(loadPapers(runDirPath)).toEqual([]);
  });

  it("round-trips papers through JSON", () => {
    const runDirPath = runDir(dir, new Date());
    const papers = [paper("a", { coarse: 1, score: 7 })];
    savePapers(runDirPath, papers);
    expect(loadPapers(runDirPath)).toEqual(papers);
  });

  it("returns an empty array when papers.json doesn't exist yet", () => {
    const runDirPath = runDir(dir, new Date());
    expect(loadPapers(runDirPath)).toEqual([]);
  });
});

describe("writeDigest", () => {
  it("writes digest.html and returns its path", () => {
    const runDirPath = runDir(dir, new Date());
    const path = writeDigest(runDirPath, "<p>hello</p>");
    expect(path).toBe(join(runDirPath, "digest.html"));
  });
});
