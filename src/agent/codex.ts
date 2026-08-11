import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRuntime } from "../runtime.js";
import type { Agent, AgentResult, AgentRunOptions } from "../types.js";
import { AgentCallError } from "./error.js";

const CAPTURE_CAP = 20_000;
const STDOUT_TAIL_LINES = 5;

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length <= CAPTURE_CAP ? next : next.slice(-CAPTURE_CAP);
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }
  child.kill("SIGTERM");
}

export class CodexAgent implements Agent {
  readonly name = "codex";

  constructor(
    private readonly bin: string,
    private readonly tempRoot: string = tmpdir(),
  ) {}

  run(prompt: string, opts: AgentRunOptions): Promise<AgentResult> {
    const runDir = mkdtempSync(join(this.tempRoot, "paperino-codex-"));
    const schemaPath = join(runDir, "schema.json");
    const outputPath = join(runDir, "output.json");
    writeFileSync(schemaPath, JSON.stringify(opts.schema), "utf-8");

    const args = [
      "exec",
      "--model",
      opts.model,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--json",
      "--color",
      "never",
      prompt,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: runDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stderr = "";
      let stdout = "";
      let settled = false;

      const cleanup = () => {
        try {
          rmSync(runDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup must not replace the call's actual result or error.
        }
      };
      const stdoutTail = () => stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(-STDOUT_TAIL_LINES);
      const fail = (error: AgentCallError) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (settled) return;
        terminateProcess(child);
        const timedOut = (opts.signal?.reason as { name?: string } | undefined)?.name === "TimeoutError";
        fail(new AgentCallError(
          timedOut ? `codex timed out after ${formatRuntime(opts.timeoutMs)}` : "codex call aborted",
          { stderr, stdoutTail: stdoutTail() },
        ));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.on("data", (data: Buffer) => {
        stdout = appendTail(stdout, data);
      });
      child.stderr!.on("data", (data: Buffer) => {
        stderr = appendTail(stderr, data);
      });

      child.on("error", (error) => {
        fail(new AgentCallError(`failed to spawn codex: ${error.message}`, { stderr, stdoutTail: stdoutTail() }));
      });
      child.stdout!.on("error", (error) => {
        fail(new AgentCallError(`stdout stream error: ${error.message}`, { stderr, stdoutTail: stdoutTail() }));
      });
      child.stderr!.on("error", (error) => {
        fail(new AgentCallError(`stderr stream error: ${error.message}`, { stderr, stdoutTail: stdoutTail() }));
      });

      child.on("close", (code) => {
        if (settled) return;
        const diagnostics = { exitCode: code, stderr, stdoutTail: stdoutTail() };
        if (code !== 0) {
          fail(new AgentCallError(`codex exited with code ${code}`, diagnostics));
          return;
        }

        let raw: string;
        try {
          raw = readFileSync(outputPath, "utf-8");
        } catch {
          fail(new AgentCallError("codex returned no structured output", diagnostics));
          return;
        }

        let output: unknown;
        try {
          output = JSON.parse(raw);
        } catch {
          fail(new AgentCallError("codex returned malformed structured output", diagnostics));
          return;
        }

        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve({ output });
      });
    });
  }
}
