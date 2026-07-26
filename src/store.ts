import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Paper } from "./types.js";

/** `YYYY-MM-DD` on arXiv's US Eastern calendar. */
export function formatAnnouncementDate(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Why a paper writes to `dir` would fail, or null if it would succeed.
 *
 * Creating the dir is deferred until write time, which is the last pipeline step —
 * so without this probe an unwritable path only surfaces *after* a run has spent
 * model calls. Actually creates the directory: `mkdir -p` is the same call the
 * write path makes, so succeeding here is the real proof, not an approximation.
 */
export function checkWritableDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code === "ENOTDIR" || code === "EEXIST") return `${dir} — a file is in the way of that path`;
    if (code === "EACCES" || code === "EPERM") return `${dir} — permission denied`;
    if (code === "EROFS") return `${dir} — read-only filesystem`;
    if (code === "ENAMETOOLONG") return `${dir} — path is too long`;
    // mkdir -p only reports ENOENT when an ancestor can't be created at all.
    if (code === "ENOENT") return `${dir} — that location can't be created`;
    return `${dir} — ${(err as Error).message}`;
  }

  // mkdir can succeed on a dir we still can't create files in (e.g. r-x perms).
  const probe = join(dir, `.paperino-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    const detail = code === "EACCES" || code === "EPERM" ? "permission denied" : (err as Error).message;
    return `${dir} — ${detail}`;
  }

  return null;
}

/** One cache file per announcement date (idempotent across re-runs). */
export function cachePath(cacheDir: string, announcedAt: Date): string {
  return join(cacheDir, `${formatAnnouncementDate(announcedAt)}.json`);
}

/** Delete an announcement's cached papers so it refetches and rescores from scratch. */
export function clearCache(cacheDir: string, announcedAt: Date): void {
  rmSync(cachePath(cacheDir, announcedAt), { force: true });
}

export function loadPapers(path: string): Paper[] {
  if (!existsSync(path)) {
    return [];
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Paper[];
}

export function savePapers(path: string, papers: Paper[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(papers, null, 2)}\n`, "utf-8");
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

/** One flat HTML file per announcement: <out-dir>/YYYY-MM-DD.html. */
export function writeDigest(outDir: string, announcedAt: Date, html: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${formatAnnouncementDate(announcedAt)}.html`);
  writeFileSync(path, html, "utf-8");
  return path;
}
