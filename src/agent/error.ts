const FIELD_CAP = 4000;

export interface AgentDiagnostics {
  exitCode?: number | null;
  stderr?: string;
  /** The agent CLI's terminal event, when it exposes one. */
  resultEvent?: unknown;
  /** Trailing stdout lines that were not usable as structured output. */
  stdoutTail?: string[];
}

/** Collapse to a single log-friendly line and cap the length. */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= FIELD_CAP
    ? collapsed
    : `${collapsed.slice(0, FIELD_CAP)}… (+${collapsed.length - FIELD_CAP} more chars)`;
}

/**
 * A failed agent call. Everything captured is inlined into `message` so a single
 * log line can diagnose an unattended run, while the individual fields remain available.
 * Each field is bounded so one bad call cannot flood the log.
 */
export class AgentCallError extends Error {
  /** The headline alone, without diagnostic fields; used for retry messages. */
  readonly summary: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly resultEvent: unknown;
  readonly stdoutTail: string[];

  constructor(summary: string, diagnostics: AgentDiagnostics = {}) {
    const { exitCode = null, stderr = "", resultEvent, stdoutTail = [] } = diagnostics;
    const parts = [summary];
    if (resultEvent !== undefined) parts.push(`result event: ${oneLine(JSON.stringify(resultEvent))}`);
    if (stderr.trim()) parts.push(`stderr: ${oneLine(stderr)}`);
    if (stdoutTail.length > 0) parts.push(`unparsed stdout: ${oneLine(stdoutTail.join(" "))}`);
    super(parts.join(" | "));
    this.name = "AgentCallError";
    this.summary = summary;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.resultEvent = resultEvent;
    this.stdoutTail = stdoutTail;
  }
}
