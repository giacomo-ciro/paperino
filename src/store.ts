import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Paper } from "./types.js";

/** `YYYY-MM-DD` for a UTC instant (matches Python's `strftime("%Y-%m-%d")`). */
export function formatUTCDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** One directory per submission window, named by its end date (idempotent across re-runs). */
export function runDir(outDir: string, windowEnd: Date): string {
  const dir = join(outDir, formatUTCDate(windowEnd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Delete a window's run directory (papers.json, digest.html) so it reruns from scratch. */
export function clearRunDir(outDir: string, windowEnd: Date): void {
  rmSync(join(outDir, formatUTCDate(windowEnd)), { recursive: true, force: true });
}

function papersPath(dir: string): string {
  return join(dir, "papers.json");
}

export function loadPapers(dir: string): Paper[] {
  const path = papersPath(dir);
  if (!existsSync(path)) {
    return [];
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Paper[];
}

export function savePapers(dir: string, papers: Paper[]): void {
  writeFileSync(papersPath(dir), `${JSON.stringify(papers, null, 2)}\n`, "utf-8");
}

/**
 * Merge freshly-fetched papers into the existing store, keyed by id.
 * Existing records (which may already carry `coarse`/`score`) win on conflict;
 * records no longer returned by fetch are kept (never deleted).
 */
export function mergePapers(existing: Paper[], fetched: Paper[]): Paper[] {
  const byId = new Map<string, Paper>();
  for (const p of existing) {
    byId.set(p.id, p);
  }
  for (const p of fetched) {
    if (!byId.has(p.id)) {
      byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

export function writeDigest(dir: string, html: string): string {
  const path = join(dir, "digest.html");
  writeFileSync(path, html, "utf-8");
  return path;
}
