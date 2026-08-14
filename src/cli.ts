import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { createAgent } from "./agent/index.js";
import { ensureConfig, loadConfig } from "./config.js";
import { buildDigest } from "./digest.js";
import { sendDigestEmail } from "./email.js";
import { fetchRecentPapers } from "./fetch.js";
import { runConfigure } from "./configure.js";
import { makeLogger, viewLogs } from "./logger.js";
import { confirmRun, makePipelineView, makeSilentPipelineView, type PipelineView } from "./progress.js";
import { formatRuntime } from "./runtime.js";
import { coarseFilter, fineScoring, type ScoringProgress } from "./scoring.js";
import { checkForUpdateAsync, readCachedUpdate } from "./update-check.js";
import {
  cachePath,
  clearCache,
  formatAnnouncementDate,
  loadPapers,
  mergePapers,
  savePapers,
  writeDigest,
} from "./store.js";
import type { Paper } from "./types.js";
import { announcementsToProcess } from "./window.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;

const program = new Command();

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a positive integer");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }

  return parsed;
}

/** Most recently submitted N papers (all of them if `maxPapers` is unset). */
function capMostRecent(papers: Paper[], maxPapers: number | undefined): Paper[] {
  if (maxPapers === undefined || papers.length <= maxPapers) {
    return papers;
  }
  return [...papers]
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, maxPapers);
}

/** Metrics only: the log gets the stage name from stageStart/stageEnd, the TUI prepends it below. */
function formatProgress(stage: "coarse" | "fine", p: ScoringProgress): string {
  const detail =
    stage === "coarse"
      ? `${p.passed}/${p.papersTotal} papers kept, `
      : "";
  return (
    `${p.papersDone}/${p.papersTotal} papers processed ` +
    `(${detail}${p.callsDone}/${p.callsTotal} calls done, ${p.failed} failed)`
  );
}

function withRuntime(text: string, ms: number): string {
  return `${text} ${pc.dim(`· ${formatRuntime(ms)}`)}`;
}

/** Progress snapshot for a stage that had nothing pending (all papers already screened/scored). */
function alreadyDoneProgress(papers: Paper[], stage: "coarse" | "fine"): ScoringProgress {
  const passed =
    stage === "coarse" ? papers.filter((p) => p.coarse === 1).length : papers.filter((p) => p.score !== undefined).length;
  return { papersDone: papers.length, papersTotal: papers.length, passed, callsDone: 0, callsTotal: 0, failed: 0 };
}

/** Open a file with the OS default handler (`open` on macOS, `xdg-open` on Linux, `start` on Windows). */
function openInBrowser(path: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [path]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", path]]
        : ["xdg-open", [path]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const LOGS_HINT = "Run paperino --logs for details.";

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const detail = `${error.name}: ${error.message}`;
  return error.cause === undefined ? detail : `${detail} (cause: ${errorDetail(error.cause)})`;
}

/** The digest survived but delivery did not, so this error carries its own user-facing message. */
class EmailDeliveryError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = "EmailDeliveryError";
  }
}

function renderDigestHtml(subject: string, body: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body>
${body}
</body>
</html>
`;
}

program
  .name("paperino")
  .description(
    "Every new arXiv paper, every day, filtered by your chosen agent down to what's actually worth your time.",
  )
  .version(packageVersion)
  .option(
    "--configure",
    "interactively configure paperino.",
    false
  )
  .option(
    "--email",
    "email each completed digest to the configured recipient.",
    false,
  )
  .option(
    "--force",
    "discard any existing run/digest for the selected announcements and rerun from scratch.",
    false,
  )
  .option(
    "--logs",
    "page through the log file with less; no pipeline run.",
    false
  )
  .option(
    "--max-papers <n>",
    "cap papers processed per announcement, most recently submitted first (default: unlimited).",
    parsePositiveInteger,
  )
  .option(
    "--only-fetch",
    "only fetch the papers from arXiv. Do NOT run the relevance-scoring pipeline.",
    false,
  )
  .option(
    "--quiet",
    "run non-interactively: no confirmation prompt, no progress output, no browser; only print the path to the output file.",
    false,
  )
  .option(
    "--last <n>",
    "number of latest arXiv announcements to process.",
    parsePositiveInteger,
    1,
  )
  .action(
    async (options: {
      configure?: boolean;
      logs?: boolean;
      email?: boolean;
      last: number;
      maxPapers?: number;
      onlyFetch?: boolean;
      force?: boolean;
      quiet?: boolean;
    }) => {
      if (options.configure) {
        await runConfigure();
        return;
      }

      ensureConfig();

      const cfg = loadConfig();
      const email = options.email ? cfg.email : undefined;

      if (options.email && !email) {
        throw new Error("email delivery is not configured — run paperino --configure");
      }

      if (options.email && options.onlyFetch) {
        throw new Error("--email cannot be used with --only-fetch because no digest is generated");
      }

      if (options.logs) {
        viewLogs(cfg.logFile);
        return;
      }

      const logger = makeLogger(cfg.logFile);

      const announcements = announcementsToProcess(new Date(), options.last);
      const maxPapers = options.maxPapers;

      checkForUpdateAsync();
      const latestVersion = readCachedUpdate(packageVersion);
      const updateAvailable = latestVersion ? { current: packageVersion, latest: latestVersion } : undefined;

      if (
        !options.quiet &&
        !(await confirmRun(
          announcements,
          cfg,
          maxPapers,
          options.force ?? false,
          options.onlyFetch ?? false,
          updateAvailable,
        ))
      ) {
        process.stderr.write(pc.dim("aborted.\n"));
        return;
      }

      const agent = createAgent(cfg);

      const outputPaths: string[] = [];
      let totalFailedCalls = 0;

      logger.pipelineStart(announcements.length);

      for (const announcement of announcements) {
        const { announcedAt, submittedFrom, submittedUntil } = announcement;
        const cacheFile = cachePath(cfg.cacheDir, announcedAt);
        const label = formatAnnouncementDate(announcedAt);
        const announcementStartedAt = performance.now();

        logger.announcementStart(label);

        const view: PipelineView = options.quiet || !process.stderr.isTTY
          ? makeSilentPipelineView()
          : makePipelineView(label, options.onlyFetch ? ["Fetching papers"] : undefined);
        let activeStage = "Fetching papers";

        try {
          logger.stageStart(activeStage);
          const fetchStartedAt = performance.now();
          if (options.force) {
            clearCache(cfg.cacheDir, announcedAt);
          }
          const existing = loadPapers(cacheFile);
          const fetched = await fetchRecentPapers(
            cfg.arxivCat,
            submittedFrom,
            submittedUntil,
            maxPapers,
            (message) => logger.detail(message),
          );
          const papers = mergePapers(existing, fetched);
          savePapers(cacheFile, papers);

          const toProcess = capMostRecent(papers, maxPapers);
          const cappedNote =
            maxPapers !== undefined && toProcess.length < papers.length
              ? ` (only scoring most recent ${toProcess.length})`
              : "";
          const fetchMetrics = `Fetched ${fetched.length} papers, ${papers.length} total in store${cappedNote}`;
          const fetchDurationMs = performance.now() - fetchStartedAt;
          view.complete(withRuntime(fetchMetrics, fetchDurationMs));
          logger.stageEnd("Fetching papers", fetchMetrics);

          if (options.onlyFetch) {
            view.stop();
            outputPaths.push(cacheFile);
            const totalDurationMs = performance.now() - announcementStartedAt;
            logger.announcementEnd(label, totalDurationMs);
            if (!options.quiet) {
              process.stderr.write(`${pc.green("Done")} ${pc.dim(`in ${formatRuntime(totalDurationMs)}. Papers saved at`)} ${cacheFile}\n\n`);
            }
            continue;
          }

          activeStage = "Coarse filtering";
          logger.stageStart(activeStage);
          const coarseStartedAt = performance.now();
          let lastCoarse: ScoringProgress | undefined;
          await coarseFilter(
            toProcess,
            cfg,
            agent,
            (p) => {
              lastCoarse = p;
              view.update(`${activeStage}: ${formatProgress("coarse", p)}`);
            },
            (err) => logger.detail(err),
          );
          const coarseProgress = lastCoarse ?? alreadyDoneProgress(toProcess, "coarse");
          const coarseMetrics = formatProgress("coarse", coarseProgress);
          const coarseDurationMs = performance.now() - coarseStartedAt;
          view.complete(withRuntime(`Coarse filtering: ${coarseMetrics}`, coarseDurationMs), coarseProgress.failed > 0);
          logger.stageEnd("Coarse filtering", coarseMetrics);
          savePapers(cacheFile, papers);

          activeStage = "Fine filtering";
          logger.stageStart(activeStage);
          const fineStartedAt = performance.now();
          let lastFine: ScoringProgress | undefined;
          await fineScoring(
            toProcess,
            cfg,
            agent,
            (p) => {
              lastFine = p;
              view.update(`${activeStage}: ${formatProgress("fine", p)}`);
            },
            (err) => logger.detail(err),
          );
          const fineProgress = lastFine ?? alreadyDoneProgress(toProcess, "fine");
          const fineMetrics = formatProgress("fine", fineProgress);
          const fineDurationMs = performance.now() - fineStartedAt;
          view.complete(withRuntime(`Fine filtering: ${fineMetrics}`, fineDurationMs), fineProgress.failed > 0);
          logger.stageEnd("Fine filtering", fineMetrics);
          savePapers(cacheFile, papers);
          view.stop();

          // Not a tracked stage in the TUI, but it writes to disk and can fail on its own.
          activeStage = "Building digest";
          logger.stageStart(activeStage);
          const { subject, body, coarsePassed, scoredAboveMin } = buildDigest(papers, announcedAt, cfg.minScore);
          const htmlPath = writeDigest(cfg.outDir, announcedAt, renderDigestHtml(subject, body));
          logger.stageEnd(
            activeStage,
            `${scoredAboveMin}/${coarsePassed} papers scored ≥ ${cfg.minScore}, written to ${htmlPath}`,
          );

          if (email) {
            activeStage = "Sending email";
            logger.stageStart(activeStage);
            try {
              await sendDigestEmail(email, subject, body);
            } catch (err) {
              throw new EmailDeliveryError(
                `paperino could not send the email; the digest is ready at ${htmlPath}. ${LOGS_HINT}`,
                { cause: err },
              );
            }
            logger.stageEnd(activeStage, `delivered to ${email.recipientAddress}`);
          }
          const totalDurationMs = performance.now() - announcementStartedAt;
          logger.announcementEnd(label, totalDurationMs);
          const failedCalls = coarseProgress.failed + fineProgress.failed;
          if (failedCalls > 0) {
            totalFailedCalls += failedCalls;
            if (!options.quiet) {
              const calls = `${failedCalls} call${failedCalls === 1 ? "" : "s"} failed`;
              process.stderr.write(
                `${pc.yellow("⚠ Done with errors")} ${pc.dim(`in ${formatRuntime(totalDurationMs)}. Digest may be incomplete: ${calls}. Run`)} paperino --logs ${pc.dim("for details.")}\n` +
                  `${pc.dim("Digest ready at")} ${htmlPath}\n`,
              );
            }
          } else if (!options.quiet) {
            process.stderr.write(`${pc.green("Done")} ${pc.dim(`in ${formatRuntime(totalDurationMs)}. Digest ready at`)} ${htmlPath}\n`);
          }
          if (email && !options.quiet) {
            process.stderr.write(`${pc.green("Email successfully sent.")} ${pc.dim("Delivered to")} ${email.recipientAddress}\n`);
          }
          if (!options.quiet) {
            process.stderr.write("\n");
          }
          outputPaths.push(htmlPath);

          if (!options.quiet) {
            openInBrowser(htmlPath);
          }
        } catch (error) {
          // EmailDeliveryError's message is stderr copy; the log wants the delivery failure itself.
          logger.stageFailed(activeStage, errorDetail(error instanceof EmailDeliveryError ? error.cause : error));
          logger.pipelineAborted();
          view.stop();
          // Every failure reads the same except email, which reports where the digest landed.
          throw error instanceof EmailDeliveryError
            ? error
            : new Error(`paperino could not finish. ${LOGS_HINT}`);
        }
      }

      logger.pipelineEnd(totalFailedCalls);

      if (options.quiet) {
        for (const path of outputPaths) {
          process.stdout.write(`${path}\n`);
        }
      }

      if (totalFailedCalls > 0) {
        process.exitCode = 1;
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.yellow(`${message}`)}\n`);
  process.exitCode = 1;
});
