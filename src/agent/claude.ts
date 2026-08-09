// based on https://github.com/kunchenguid/gnhf/blob/main/src/core/agents/claude.ts
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { formatRuntime } from "../runtime.js";
import type { Agent, AgentOutput, AgentResult, AgentRunOptions, JsonSchema } from "../types.js";

const FIELD_CAP = 4000; // per diagnostic field, so one bad call can't dump megabytes into the log
const STDOUT_TAIL_LINES = 5;

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

/** Collapse to a single log-friendly line and cap the length. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= FIELD_CAP
    ? collapsed
    : `${collapsed.slice(0, FIELD_CAP)}… (+${collapsed.length - FIELD_CAP} more chars)`;
}

interface ClaudeDiagnostics {
  exitCode?: number | null;
  stderr?: string;
  /** The terminal `result` event verbatim — carries claude's own error text. */
  resultEvent?: unknown;
  /** Trailing stdout lines that were not parseable as JSON events. */
  stdoutTail?: string[];
}

/**
 * A failed claude call. Everything we captured is inlined into `message` so a single
 * log line is enough to diagnose an unattended run; the fields stay available too.
 *
 * ` | ` is the log's field-boundary marker and is reserved for that: claude's stderr and
 * JSON payloads contain colons, commas and semicolons freely, so nothing else survives
 * them unambiguously. Every other message in the log uses `<subject> <verb>: <detail>`.
 */
export class ClaudeCallError extends Error {
  /** The headline alone, without the diagnostic fields — logged on retries, which repeat. */
  readonly summary: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly resultEvent: unknown;
  readonly stdoutTail: string[];

  constructor(summary: string, diagnostics: ClaudeDiagnostics = {}) {
    const { exitCode = null, stderr = "", resultEvent, stdoutTail = [] } = diagnostics;
    const parts = [summary];
    if (resultEvent !== undefined) parts.push(`result event: ${oneLine(JSON.stringify(resultEvent))}`);
    if (stderr.trim()) parts.push(`stderr: ${oneLine(stderr)}`);
    if (stdoutTail.length > 0) parts.push(`unparsed stdout: ${oneLine(stdoutTail.join(" "))}`);
    super(parts.join(" | "));
    this.name = "ClaudeCallError";
    this.summary = summary;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.resultEvent = resultEvent;
    this.stdoutTail = stdoutTail;
  }
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
function readJSONLStream(
  stream: Readable,
  onEvent: (event: ClaudeEvent) => void,
  onUnparsedLine: (line: string) => void,
): void {
  let buffer = "";

  function consume(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as ClaudeEvent);
    } catch {
      onUnparsedLine(trimmed); // plain-text CLI diagnostics land here instead of being dropped
    }
  }

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  });

  // the last line can arrive without a trailing newline; flushing on end keeps a
  // complete final result event from being mistaken for "no result event"
  stream.on("end", () => {
    const rest = buffer;
    buffer = "";
    consume(rest);
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
      const stdoutTail: string[] = [];

      const onAbort = () => {
        if (settled) return;
        settled = true;
        terminateClaudeProcess(child);
        // the pool aborts via AbortSignal.timeout, so a TimeoutError reason means we ran long
        const timedOut = (opts.signal?.reason as { name?: string } | undefined)?.name === "TimeoutError";
        reject(
          new ClaudeCallError(
            timedOut ? `claude timed out after ${formatRuntime(opts.timeoutMs)}` : "claude call aborted",
            { stderr, stdoutTail },
          ),
        );
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new ClaudeCallError(`failed to spawn claude: ${err.message}`, { stderr, stdoutTail }));
      });

      child.stdout!.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new ClaudeCallError(`stdout stream error: ${err.message}`, { stderr, stdoutTail }));
      });

      child.stderr!.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new ClaudeCallError(`stderr stream error: ${err.message}`, { stderr, stdoutTail }));
      });

      let resultEvent: ClaudeResultEvent | null = null;
      let finalStructuredResultEvent: ClaudeResultEvent | null = null;

      readJSONLStream(
        child.stdout!,
        (event) => {
          if (event.type !== "result") return;
          const next = event as ClaudeResultEvent;
          if (isFinalStructuredResult(next)) {
            finalStructuredResultEvent = next;
          } else if (!finalStructuredResultEvent) {
            resultEvent = next;
          }
        },
        (line) => {
          stdoutTail.push(line);
          if (stdoutTail.length > STDOUT_TAIL_LINES) stdoutTail.shift();
        },
      );

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener("abort", onAbort);

        const terminalResultEvent: ClaudeResultEvent | null = finalStructuredResultEvent ?? resultEvent;
        const diagnostics = {
          exitCode: code,
          stderr,
          stdoutTail,
          resultEvent: terminalResultEvent ?? undefined,
        };

        if (code !== 0) {
          reject(new ClaudeCallError(`claude exited with code ${code}`, diagnostics));
          return;
        }
        if (!terminalResultEvent) {
          reject(new ClaudeCallError("claude returned no result event", diagnostics));
          return;
        }
        if (terminalResultEvent.is_error || terminalResultEvent.subtype !== "success") {
          reject(new ClaudeCallError("claude reported an error", diagnostics));
          return;
        }
        if (!terminalResultEvent.structured_output) {
          reject(new ClaudeCallError("claude returned no structured_output", diagnostics));
          return;
        }

        resolve({ output: terminalResultEvent.structured_output });
      });
    });
  }
}
