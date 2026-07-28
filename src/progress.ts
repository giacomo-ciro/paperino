import { createInterface } from "node:readline/promises";
import cliSpinners from "cli-spinners";
import pc from "picocolors";
import type { Config } from "./types.js";
import type { ArxivAnnouncement } from "./window.js";

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
const announcementDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: ET_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** `Mon, 27 Jul 2026` on arXiv's US Eastern calendar. */
function formatAnnouncementDate(d: Date): string {
  return announcementDateFormatter.format(d);
}

/**
 * Renders the run summary (announcements, config, warnings) in the same visual
 * language as the stage tracker, then prompts for confirmation. The whole
 * block is wiped from the screen right before returning, so it doesn't
 * linger once the animated stage tracker takes over.
 */
export async function confirmRun(
  announcements: ArxivAnnouncement[],
  cfg: Config,
  maxPapers: number | undefined,
  force: boolean,
  onlyFetch: boolean,
  updateAvailable?: { current: string; latest: string },
): Promise<boolean> {
  const frame = new Frame();

  const lines: string[] = [];
  if (updateAvailable) {
    lines.push("");
    lines.push(
      pc.yellow(
        `A new version of paperino is available: ${updateAvailable.current} -> ${updateAvailable.latest} (npm i -g @giacomo-ciro/paperino)`,
      ),
    );
  }
  lines.push("");
  const announcementLabel =
    announcements.length === 1
      ? "1 arXiv announcement to process"
      : `${announcements.length} arXiv announcements to process`;
  lines.push(`${announcementLabel}${onlyFetch ? " (only fetching)" : ""}:`);
  lines.push("");
  for (const announcement of announcements) {
    lines.push(`  ${pc.cyan("›")} ${formatAnnouncementDate(announcement.announcedAt)}`);
  }
  lines.push("");
  const maxProcessed = maxPapers !== undefined ? String(maxPapers) : "all";
  lines.push(`${pc.dim("Max papers/announcement")}  ${maxProcessed}`);
  if (!onlyFetch) {
    lines.push(
      `${pc.dim("Coarse model")}            ${cfg.coarse.model} (${cfg.coarse.callSize} papers per call, ${cfg.coarse.maxWorkers} concurrent calls at most)`,
    );
    lines.push(
      `${pc.dim("Fine model")}              ${cfg.fine.model} (${cfg.fine.callSize} papers per call, ${cfg.fine.maxWorkers} concurrent calls at most)`,
    );
  }
  if (force) {
    lines.push("");
    lines.push(pc.yellow("existing runs/digests for these announcements will be discarded and rerun from scratch."));
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
 * Animated 3-line stage tracker for one arXiv announcement, written to stderr.
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

export function makePipelineView(announcementLabel: string, stageLabels: readonly string[] = STAGE_LABELS): PipelineView {
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

  process.stderr.write(`\nProcessing announcement ${announcementLabel}\n\n`);
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
      if (stopped) return;
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
