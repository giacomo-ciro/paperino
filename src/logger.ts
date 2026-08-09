import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { formatRuntime } from "./runtime.js";

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return `${date} ${time}`;
}

/** Appends timestamped lines to `logPath` (mkdir -p'd once, up front). */
export interface Logger {
  pipelineStart(announcementCount: number): void;
  announcementStart(label: string): void;
  announcementEnd(label: string, durationMs: number): void;
  stageStart(label: string): void;
  stageEnd(label: string, metrics: string): void;
  stageFailed(stageLabel: string, error: string): void;
  /**
   * One line from inside the active stage, indented under it; stageStart/stageEnd
   * already name the stage, so the message carries only its own content.
   */
  detail(message: string): void;
  pipelineEnd(failedCalls: number): void;
  pipelineAborted(): void;
}

export function makeLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  closeSync(openSync(logPath, "a"));

  function write(line: string): void {
    appendFileSync(logPath, `[${timestamp()}] ${line}\n`, "utf-8");
  }

  return {
    pipelineStart(announcementCount: number): void {
      write(`pipeline started (${announcementCount} announcement${announcementCount === 1 ? "" : "s"} to process)`);
    },
    announcementStart(label: string): void {
      write(`processing announcement ${label}`);
    },
    announcementEnd(label: string, durationMs: number): void {
      write(`announcement ${label} finished in ${formatRuntime(durationMs)}`);
    },
    stageStart(label: string): void {
      write(`  ${label} started`);
    },
    stageEnd(label: string, metrics: string): void {
      write(`  ${label} finished: ${metrics}`);
    },
    stageFailed(stageLabel: string, error: string): void {
      write(`  ${stageLabel} failed: ${error}`);
    },
    detail(message: string): void {
      write(`    ${message}`);
    },
    pipelineEnd(failedCalls: number): void {
      write(
        failedCalls === 0
          ? "pipeline finished"
          : `pipeline finished with ${failedCalls} failed call${failedCalls === 1 ? "" : "s"}`,
      );
    },
    pipelineAborted(): void {
      write("pipeline aborted");
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
