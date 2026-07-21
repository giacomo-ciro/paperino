import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date} ${time}`;
}

/** Appends timestamped lines to `logPath` (mkdir -p'd once, up front). */
export interface Logger {
  pipelineStart(windowCount: number): void;
  windowStart(label: string): void;
  stageStart(label: string): void;
  callFailed(stageLabel: string, error: string): void;
  stageEnd(label: string, metrics: string): void;
  pipelineEnd(): void;
}

export function makeLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  closeSync(openSync(logPath, "a"));

  function write(line: string): void {
    appendFileSync(logPath, `[${timestamp()}] ${line}\n`, "utf-8");
  }

  return {
    pipelineStart(windowCount: number): void {
      write(`pipeline started (${windowCount} window(s) to process)`);
    },
    windowStart(label: string): void {
      write(`processing window ${label}`);
    },
    stageStart(label: string): void {
      write(`  stage started: ${label}`);
    },
    callFailed(stageLabel: string, error: string): void {
      write(`  call failed: ${stageLabel} — ${error}`);
    },
    stageEnd(label: string, metrics: string): void {
      write(`  stage finished: ${label} — ${metrics}`);
    },
    pipelineEnd(): void {
      write("pipeline finished");
    },
  };
}

/** Opens the log file in `less`, jumping to the end, inheriting stdio until the user quits. */
export function viewLogs(logPath: string): void {
  // create the log dir, if missing
  mkdirSync(dirname(logPath), { recursive: true });
  // create the log file, if missing
  closeSync(openSync(logPath, "a"));
  // spawn less, jumping to the end of the file (+G); press Shift+F inside to follow live updates
  spawnSync("less", ["+G", logPath], { stdio: "inherit" });
  // The "Sync" part means Node's call blocks and waits for
  // the child process to exit before returning control
}
