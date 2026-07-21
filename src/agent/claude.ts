// trimmed from docs/blueprints/claude-wrapper.ts — see docs/plan.md for what was dropped and why.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import type { Agent, AgentOutput, AgentResult, AgentRunOptions, JsonSchema } from "../types.js";

interface ClaudeResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  structured_output: AgentOutput | null;
}

type ClaudeEvent = ClaudeResultEvent | { type: string };

function isFinalStructuredResult(event: ClaudeResultEvent): boolean {
  return !event.is_error && event.subtype === "success" && !!event.structured_output;
}

function buildClaudeArgs(prompt: string, model: string, schema: JsonSchema): string[] {
  return [
    "--model",
    model,
    "-p",
    prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    JSON.stringify(schema),
    "--allowedTools",
    "StructuredOutput",
    // paperino runs unattended (cron, etc.) with no TTY to approve the
    // StructuredOutput tool call that --json-schema depends on internally.
    // this is safe as we only allow to output text (no bash, no edit, nothing)
    // even if malicioius prompt injection from abstracts / titles, 
    // claude can only output text, which is not dangerous.
    "--dangerously-skip-permissions",
  ];
}

function terminateClaudeProcess(child: ReturnType<typeof spawn>): void {
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

/** Split a newline-delimited JSON stream into parsed events, tolerating partial chunks. */
function readJSONLStream(stream: Readable, onEvent: (event: ClaudeEvent) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onEvent(JSON.parse(trimmed) as ClaudeEvent);
      } catch {
        // ignore malformed lines (partial writes, non-JSON diagnostics)
      }
    }
  });
}

export class ClaudeAgent implements Agent {
  readonly name = "claude";

  constructor(private readonly bin: string) {}

  run(prompt: string, opts: AgentRunOptions): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, buildClaudeArgs(prompt, opts.model, opts.schema), {
        cwd: tmpdir(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stderr = "";
      let settled = false;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        terminateClaudeProcess(child);
        reject(new Error("claude call aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      child.stdout!.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`stdout stream error: ${err.message}`));
      });

      child.stderr!.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`stderr stream error: ${err.message}`));
      });

      let resultEvent: ClaudeResultEvent | null = null;
      let finalStructuredResultEvent: ClaudeResultEvent | null = null;

      readJSONLStream(child.stdout!, (event) => {
        if (event.type !== "result") return;
        const next = event as ClaudeResultEvent;
        if (isFinalStructuredResult(next)) {
          finalStructuredResultEvent = next;
        } else if (!finalStructuredResultEvent) {
          resultEvent = next;
        }
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);

        if (code !== 0) {
          reject(new Error(`claude exited with code ${code}: ${stderr}`));
          return;
        }

        const terminalResultEvent = finalStructuredResultEvent ?? resultEvent;

        if (!terminalResultEvent) {
          reject(new Error("claude returned no result event"));
          return;
        }
        if (terminalResultEvent.is_error || terminalResultEvent.subtype !== "success") {
          reject(new Error(`claude reported error: ${JSON.stringify(terminalResultEvent)}`));
          return;
        }
        if (!terminalResultEvent.structured_output) {
          reject(new Error("claude returned no structured_output"));
          return;
        }

        resolve({ output: terminalResultEvent.structured_output });
      });
    });
  }
}
