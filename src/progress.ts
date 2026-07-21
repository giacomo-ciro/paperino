import { createInterface } from "node:readline/promises";
import cliSpinners from "cli-spinners";
import pc from "picocolors";
import type { Config } from "./types.js";

const STAGE_LABELS = ["Fetching papers", "Coarse filtering", "Fine filtering"] as const;
export type Stage = 0 | 1 | 2;

const SPINNER = cliSpinners.dots;

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Visible width of a line once SGR color codes are stripped. */
function visibleWidth(line: string): number {
  return line.replace(ANSI_PATTERN, "").length;
}

/** How many physical terminal rows a line occupies once wrapped at `columns`. */
function wrappedRows(line: string, columns: number): number {
  return Math.max(1, Math.ceil(visibleWidth(line) / columns));
}

/**
 * Redraws a block of lines in place on stderr, tracking how many physical
 * rows the last frame occupied (accounting for wrapping) so it can be
 * cleared cleanly before the next frame — or erased entirely via `clear()`.
 */
class Frame {
  private linesPrinted = 0;

  draw(lines: string[]): void {
    const columns = process.stderr.columns || 80;
    const rowCounts = lines.map((line) => wrappedRows(line, columns));
    const totalRows = rowCounts.reduce((sum, n) => sum + n, 0);

    if (this.linesPrinted > 0) {
      process.stderr.write(`\x1b[${this.linesPrinted}A`);
      // clear every physical row the previous frame occupied before rewriting —
      // a wrapped line's continuation rows never got their own `\x1b[2K` last time.
      for (let i = 0; i < this.linesPrinted; i++) {
        process.stderr.write(i === this.linesPrinted - 1 ? "\x1b[2K" : "\x1b[2K\x1b[1B");
      }
      // `\x1b[0A` is not a no-op — terminals treat a 0 parameter as the default (1),
      // moving up a row that was never printed. Only move up when there's a row to skip.
      if (this.linesPrinted > 1) {
        process.stderr.write(`\x1b[${this.linesPrinted - 1}A`);
      }
    }
    for (const line of lines) {
      process.stderr.write(`${line}\n`);
    }
    this.linesPrinted = totalRows;
  }

  /**
   * Erase everything this frame printed, leaving the cursor where the frame started.
   * `extraLines` accounts for rows printed after the last `draw()` outside of Frame's
   * control (e.g. the newline a TTY echoes when the user presses Enter at a prompt).
   */
  clear(extraLines = 0): void {
    const rows = this.linesPrinted + extraLines;
    if (rows === 0) return;
    process.stderr.write(`\x1b[${rows}A`);
    for (let i = 0; i < rows; i++) {
      process.stderr.write(i === rows - 1 ? "\x1b[2K" : "\x1b[2K\x1b[1B");
    }
    if (rows > 1) {
      process.stderr.write(`\x1b[${rows - 1}A`);
    }
    this.linesPrinted = 0;
  }
}

const ET_TIME_ZONE = "America/New_York";
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const weekdayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: ET_TIME_ZONE });
const etTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const localTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

/** `YYYY-MM-DD (Ddd)` in ET, for the confirmation summary. */
function formatETDate(d: Date): string {
  const parts = Object.fromEntries(etTimeFormatter.formatToParts(d).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = weekdayFormatter.format(d);
  return `${date} (${weekday})`;
}

/** `14:00 ET (your timezone: HH:mm <zone>)` — the cutoff time shared by both window boundaries. */
function formatCutoffTime(d: Date): string {
  const parts = Object.fromEntries(etTimeFormatter.formatToParts(d).map((p) => [p.type, p.value]));
  const etTime = `${parts.hour}:${parts.minute} ET`;

  if (LOCAL_TIME_ZONE === ET_TIME_ZONE) {
    return etTime;
  }

  const localParts = Object.fromEntries(localTimeFormatter.formatToParts(d).map((p) => [p.type, p.value]));
  const localTime = `${localParts.hour}:${localParts.minute} ${localParts.timeZoneName}`;
  return `${etTime} (your timezone: ${localTime})`;
}

/**
 * Renders the run summary (windows, config, warnings) in the same visual
 * language as the stage tracker, then prompts for confirmation. The whole
 * block is wiped from the screen right before returning, so it doesn't
 * linger once the animated stage tracker takes over.
 */
export async function confirmRun(
  windows: [Date, Date][],
  cfg: Config,
  maxPapers: number | undefined,
  force: boolean,
  onlyFetch: boolean,
): Promise<boolean> {
  const frame = new Frame();

  const lines: string[] = [];
  lines.push("");
  lines.push(`${windows.length} submission window(s) to process${onlyFetch ? " (only fetching)" : ""}:`);
  lines.push("");
  for (const [start, end] of windows) {
    lines.push(`  ${pc.cyan("›")} ${formatETDate(start)} ${pc.dim("->")} ${formatETDate(end)}`);
  }
  if (windows.length > 0) {
    const cutoff = formatCutoffTime(windows[windows.length - 1][1]);
    lines.push("");
    lines.push(pc.dim(`Each window starts and ends at ${cutoff}`));
  }
  lines.push("");
  const maxProcessed = maxPapers !== undefined ? String(maxPapers) : "all";
  lines.push(`${pc.dim("Max papers/window")}  ${maxProcessed}`);
  if (!onlyFetch) {
    lines.push(
      `${pc.dim("Coarse model")}       ${cfg.coarse.model} (${cfg.coarse.callSize} papers per call, ${cfg.coarse.maxWorkers} concurrent calls at most)`,
    );
    lines.push(
      `${pc.dim("Fine model")}         ${cfg.fine.model} (${cfg.fine.callSize} papers per call, ${cfg.fine.maxWorkers} concurrent calls at most)`,
    );
  }
  if (force) {
    lines.push("");
    lines.push(pc.yellow("existing runs/digests for these windows will be discarded and rerun from scratch."));
  }
  lines.push("");
  lines.push(pc.dim("Press Enter to proceed (any other key to abort)"));

  frame.draw(lines);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let confirmed: boolean;
  try {
    const answer = await rl.question("");
    confirmed = answer.trim() === "";
  } finally {
    rl.close();
  }

  // the TTY echoes the newline from the user's keypress, which Frame never printed itself.
  frame.clear(1);
  return confirmed;
}

/**
 * Animated 3-line stage tracker for one submission window, written to stderr.
 * Redraws the whole block in place on each spinner tick; completed stages
 * freeze as a green checkmark, the active stage spins, pending stages stay dim.
 */
export interface PipelineView {
  /** Update the message for the currently active stage. */
  update(text: string): void;
  /** Freeze the active stage's line with final text, advance to the next stage. `failed` renders the checkmark as a yellow warning. */
  complete(finalText: string, failed?: boolean): void;
  /** Stop the animation and leave the final frame on screen. */
  stop(): void;
}

export function makePipelineView(windowLabel: string, stageLabels: readonly string[] = STAGE_LABELS): PipelineView {
  let index = 0;
  let frameNum = 0;
  let stopped = false;
  const text: string[] = [...stageLabels];
  const failedStages = new Set<number>();
  const frame = new Frame();
  let timer: NodeJS.Timeout | undefined;

  function renderLine(i: number): string {
    const step = pc.dim(`Step ${i + 1}`);
    if (i < index) {
      const mark = failedStages.has(i) ? pc.yellow("✓") : pc.green("✓");
      return `${step} ${mark} ${text[i]}`;
    }
    if (i === index && !stopped) {
      const spinnerFrame = pc.cyan(SPINNER.frames[frameNum % SPINNER.frames.length]);
      return `${step} ${spinnerFrame} ${text[i]}`;
    }
    return pc.dim(`Step ${i + 1} ○ ${text[i]}`);
  }

  function draw(): void {
    frame.draw(stageLabels.map((_, i) => renderLine(i)));
  }

  process.stderr.write(`\nProcessing window ${windowLabel}\n\n`);
  draw();
  timer = setInterval(() => {
    frameNum++;
    draw();
  }, SPINNER.interval);

  return {
    update(newText: string): void {
      text[index] = newText;
    },
    complete(finalText: string, failed = false): void {
      text[index] = finalText;
      if (failed) failedStages.add(index);
      index++;
      if (index < stageLabels.length) {
        text[index] = stageLabels[index];
      }
    },
    stop(): void {
      if (timer) clearInterval(timer);
      stopped = true;
      draw();
      process.stderr.write("\n");
    },
  };
}

/** Non-interactive fallback (--quiet or non-TTY stderr): no animation, no output at all. */
export function makeSilentPipelineView(): PipelineView {
  return {
    update(): void {},
    complete(): void {},
    stop(): void {},
  };
}
