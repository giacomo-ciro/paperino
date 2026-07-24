import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

const CACHE_PATH = join(CONFIG_DIR, "update-check.json");
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/@giacomo-ciro/paperino/latest";

interface UpdateCache {
  latestVersion: string;
  checkedAt: string;
}

/** True if `a` is a greater semver than `b` (major.minor.patch only). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) > (pb[i] ?? 0);
    }
  }
  return false;
}

/**
 * Reads the last cached update-check result and returns the latest version
 * if it's newer than `currentVersion`. Never touches the network — purely
 * reads whatever `checkForUpdateAsync` last wrote to disk.
 */
export function readCachedUpdate(currentVersion: string, cachePath: string = CACHE_PATH): string | undefined {
  if (!existsSync(cachePath)) {
    return undefined;
  }
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as UpdateCache;
    return isNewer(cache.latestVersion, currentVersion) ? cache.latestVersion : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kicks off a detached, unref'd background process that fetches the latest
 * published version from npm and writes it to the cache file for next run
 * to read. Never awaited by the caller, so it adds no latency to this run.
 */
export function checkForUpdateAsync(cachePath: string = CACHE_PATH): void {
  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as UpdateCache;
      if (Date.now() - new Date(cache.checkedAt).getTime() < STALE_AFTER_MS) {
        return;
      }
    } catch {
      // fall through and refresh a corrupt cache
    }
  }

  const script = `
    const fs = require("node:fs");
    const path = ${JSON.stringify(cachePath)};
    fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
    fetch(${JSON.stringify(REGISTRY_URL)}, { signal: AbortSignal.timeout(5000) })
      .then((res) => res.json())
      .then((pkg) => {
        fs.writeFileSync(path, JSON.stringify({ latestVersion: pkg.version, checkedAt: new Date().toISOString() }));
      })
      .catch(() => {});
  `;

  try {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort; a failed spawn just means no update banner next run
  }
}
