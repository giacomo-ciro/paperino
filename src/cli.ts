import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { ClaudeAgent } from "./agent/claude.js";
import { CONFIG_PATH, ensureConfig, loadConfig, openConfigInEditor } from "./config.js";
import { buildDigest } from "./digest.js";
import { fetchRecentPapers } from "./fetch.js";
import { makeLogger, viewLogs } from "./logger.js";
import { confirmRun, makePipelineView, makeSilentPipelineView, type PipelineView } from "./progress.js";
import { coarseFilter, fineScoring, type ScoringProgress } from "./scoring.js";
import {
  clearRunDir,
  formatUTCDate,
  loadPapers,
  mergePapers,
  runDir,
  savePapers,
  writeDigest,
} from "./store.js";
import type { Paper } from "./types.js";
import { windowsToProcess } from "./window.js";

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
    throw new InvalidArgumentError("must be a positive integer (1-indexed)");
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

function formatProgress(stage: "coarse" | "fine", p: ScoringProgress): string {
  const stageName = stage === "coarse" ? "Coarse" : "Fine";
  const detail =
    stage === "coarse"
      ? `${p.passed}/${p.papersTotal} papers kept, `
      : "";
  return (
    `${stageName} filtering: ${p.papersDone}/${p.papersTotal} papers processed ` +
    `(${detail}${p.callsDone}/${p.callsTotal} calls done, ${p.failed} failed)`
  );
}

/** Progress snapshot for a stage that had nothing pending (all papers already screened/scored). */
function alreadyDoneProgress(papers: Paper[], stage: "coarse" | "fine"): ScoringProgress {
  const passed =
    stage === "coarse" ? papers.filter((p) => p.coarse === 1).length : papers.filter((p) => p.score !== undefined).length;
  return { papersDone: papers.length, papersTotal: papers.length, passed, callsDone: 0, callsTotal: 0, failed: 0 };
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
    "Every new arXiv paper, every day, filtered by Claude Code down to what's actually worth your time.",
  )
  .version(packageVersion)
  .option(
    "--configure",
    `open ${CONFIG_PATH} in your default editor.`,
    false
  )
  .option(
    "--email",
    "get the digest directly to your inbox (coming soon).",
    false,
  )
  .option(
    "--force",
    "discard any existing run/digest for the given windows and rerun from scratch.",
    false,
  )
  .option(
    "--logs",
    "page through the log file with less; no pipeline run.",
    false
  )
  .option(
    "--max-papers <n>",
    "cap papers processed per window, most recently submitted first (default: unlimited).",
    parsePositiveInteger,
  )
  .option(
    "--only-fetch",
    "only fetch the papers from arXiv. Do NOT run the relevance-scoring pipeline.",
    false,
  )
  .option(
    "--quiet",
    "suppress progress output; only print the path to the output file.",
    false,
  )
  .option(
    "--start-from <n>",
    "1-indexed window to start from, most recent first .",
    parsePositiveInteger,
    1,
  )
  .option(
    "--windows <n>",
    "number of windows to process, walking forward from --start-from toward the present.",
    parsePositiveInteger,
    1,
  )
  .option("-y, --yes", "skip the confirmation prompt and run immediately.", false)
  .action(
    async (options: {
      configure?: boolean;
      logs?: boolean;
      email?: boolean;
      startFrom: number;
      windows: number;
      maxPapers?: number;
      onlyFetch?: boolean;
      force?: boolean;
      quiet?: boolean;
      yes?: boolean;
    }) => {
      if (options.email) {
        throw new Error("email delivery is not implemented yet");
      }

      ensureConfig();

      if (options.configure) {
        openConfigInEditor();
        return;
      }

      const cfg = loadConfig();

      if (options.logs) {
        viewLogs(cfg.logFile);
        return;
      }

      const logger = makeLogger(cfg.logFile);

      const windows = windowsToProcess(new Date(), options.startFrom, options.windows);
      const maxPapers = options.maxPapers;

      if (
        !options.yes &&
        !(await confirmRun(windows, cfg, maxPapers, options.force ?? false, options.onlyFetch ?? false))
      ) {
        process.stderr.write(pc.dim("aborted.\n"));
        return;
      }

      const agent = new ClaudeAgent(cfg.claudeBinary);

      const outputPaths: string[] = [];
      let hadFailures = false;

      logger.pipelineStart(windows.length);

      for (const [start, end] of windows) {
        if (options.force) {
          clearRunDir(cfg.outDir, end);
        }
        const dir = runDir(cfg.outDir, end);
        const label = formatUTCDate(end);

        logger.windowStart(label);

        const view: PipelineView = options.quiet
          ? makeSilentPipelineView()
          : makePipelineView(label, options.onlyFetch ? ["Fetching papers"] : undefined);

        logger.stageStart("Fetching papers");
        const existing = loadPapers(dir);
        const fetched = await fetchRecentPapers(cfg.arxivCat, start, end, maxPapers);
        const papers = mergePapers(existing, fetched);
        savePapers(dir, papers);

        const toProcess = capMostRecent(papers, maxPapers);
        const cappedNote =
          maxPapers !== undefined && toProcess.length < papers.length
            ? ` (only scoring most recent ${toProcess.length})`
            : "";
        const fetchMetrics = `Fetched ${fetched.length} papers, ${papers.length} total in store${cappedNote}`;
        view.complete(fetchMetrics);
        logger.stageEnd("Fetching papers", fetchMetrics);

        if (options.onlyFetch) {
          view.stop();
          outputPaths.push(`${dir}/papers.json`);
          continue;
        }

        logger.stageStart("Coarse filtering");
        let lastCoarse: ScoringProgress | undefined;
        await coarseFilter(
          toProcess,
          cfg,
          agent,
          (p) => {
            lastCoarse = p;
            view.update(formatProgress("coarse", p));
          },
          (err) => logger.callFailed("Coarse filtering", err),
        );
        const coarseProgress = lastCoarse ?? alreadyDoneProgress(toProcess, "coarse");
        const coarseMetrics = formatProgress("coarse", coarseProgress);
        view.complete(coarseMetrics, coarseProgress.failed > 0);
        logger.stageEnd("Coarse filtering", coarseMetrics);
        savePapers(dir, papers);

        logger.stageStart("Fine filtering");
        let lastFine: ScoringProgress | undefined;
        await fineScoring(
          toProcess,
          cfg,
          agent,
          (p) => {
            lastFine = p;
            view.update(formatProgress("fine", p));
          },
          (err) => logger.callFailed("Fine filtering", err),
        );
        const fineProgress = lastFine ?? alreadyDoneProgress(toProcess, "fine");
        const fineMetrics = formatProgress("fine", fineProgress);
        view.complete(fineMetrics, fineProgress.failed > 0);
        logger.stageEnd("Fine filtering", fineMetrics);
        savePapers(dir, papers);
        view.stop();

        const { subject, body } = buildDigest(papers, label, cfg.minScore);
        const htmlPath = writeDigest(dir, renderDigestHtml(subject, body));
        const windowFailed = coarseProgress.failed > 0 || fineProgress.failed > 0;
        if (windowFailed) {
          hadFailures = true;
          const failedCalls = coarseProgress.failed + fineProgress.failed;
          if (!options.quiet) {
            process.stderr.write(
              `${pc.yellow("⚠ Done with errors.")} ${pc.dim(`Digest may be incomplete: ${failedCalls} call(s) failed. Run`)} paperino --logs ${pc.dim("for details.")}\n` +
                `${pc.dim("Digest ready at")} ${htmlPath}\n\n`,
            );
          }
        } else if (!options.quiet) {
          process.stderr.write(`${pc.green("Done.")} ${pc.dim("Digest ready at")} ${htmlPath}\n\n`);
        }
        outputPaths.push(htmlPath);
      }

      logger.pipelineEnd();

      if (options.quiet) {
        for (const path of outputPaths) {
          process.stdout.write(`${path}\n`);
        }
      }

      if (hadFailures) {
        process.exitCode = 1;
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});
