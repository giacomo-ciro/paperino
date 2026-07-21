import { runPool } from "./agent/pool.js";
import { COARSE_SCHEMA, fillPrompt, FINE_SCHEMA } from "./schemas.js";
import type { Agent, Config, FineEntry, Paper } from "./types.js";

export interface ScoringProgress {
  papersDone: number;
  papersTotal: number;
  passed: number; // coarse: papers kept (coarse===1); fine: papers successfully scored
  callsDone: number;
  callsTotal: number;
  failed: number; // calls that errored (after retries) or returned a malformed shape
}

/** Group items into chunks of `size`, one chunk per claude call. */
function groupForCalls<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

function coarseFlag(verdicts: Map<string, unknown>, paperId: string): 0 | 1 {
  const raw = verdicts.get(paperId);
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) && parsed === 0 ? 0 : 1; // missing/garbled verdict: keep the paper
}

/** Title-only screening: mark each paper coarse: 0|1. Fail-open on errors. */
export async function coarseFilter(
  papers: Paper[],
  cfg: Config,
  agent: Agent,
  onProgress?: (progress: ScoringProgress) => void,
  onCallFailed?: (error: string) => void,
): Promise<void> {
  const pending = papers.filter((p) => p.coarse === undefined);
  if (pending.length === 0) return;

  const calls = groupForCalls(pending, cfg.coarse.callSize);
  const prompts = calls.map((c) =>
    fillPrompt(cfg.coarse.prompt, {
      research_interests: cfg.researchInterests,
      papers: c.map((p) => `${p.id} — ${p.title}`).join("\n"),
    }),
  );

  let papersDone = 0;
  let kept = 0;
  let failed = 0;

  onProgress?.({ papersDone: 0, papersTotal: pending.length, passed: 0, callsDone: 0, callsTotal: calls.length, failed: 0 });

  await runPool(agent, prompts, {
    model: cfg.coarse.model,
    schema: COARSE_SCHEMA,
    maxWorkers: cfg.coarse.maxWorkers,
    timeoutMs: cfg.callTimeoutMs,
    retries: cfg.callRetries,
    onAttemptFailed: (error, _index, attempt, totalAttempts) => {
      onCallFailed?.(`attempt ${attempt}/${totalAttempts} failed, retrying — ${error}`);
    },
    onProgress: (output, index, callsDone, callsTotal) => {
      const c = calls[index];
      const entries =
        output && typeof output === "object" && !Array.isArray(output) && !(output instanceof Error)
          ? (output as { verdicts?: unknown }).verdicts
          : undefined;
      const callFailed = output instanceof Error || !Array.isArray(entries);

      if (callFailed) {
        failed++;
        onCallFailed?.(output instanceof Error ? output.message : "malformed output shape");
      }

      const verdicts = new Map<string, unknown>();
      if (!callFailed) {
        for (const entry of entries) {
          if (entry && typeof entry === "object" && "id" in entry) {
            verdicts.set(String((entry as { id: unknown }).id), (entry as { coarse: unknown }).coarse);
          }
        }
      }

      for (const p of c) {
        p.coarse = callFailed ? 1 : coarseFlag(verdicts, p.id);
        if (p.coarse === 1) kept++;
      }
      papersDone += c.length;
      onProgress?.({ papersDone, papersTotal: pending.length, passed: kept, callsDone, callsTotal, failed });
    },
  });
}

/** Score coarse-passed papers on title+abstract; failed calls stay unscored. */
export async function fineScoring(
  papers: Paper[],
  cfg: Config,
  agent: Agent,
  onProgress?: (progress: ScoringProgress) => void,
  onCallFailed?: (error: string) => void,
): Promise<void> {
  const pending = papers.filter((p) => p.coarse === 1 && p.score === undefined);
  if (pending.length === 0) return;

  const calls = groupForCalls(pending, cfg.fine.callSize);
  const prompts = calls.map((c) =>
    fillPrompt(cfg.fine.prompt, {
      research_interests: cfg.researchInterests,
      papers: c.map((p) => `id: ${p.id}\ntitle: ${p.title}\nabstract: ${p.abstract}`).join("\n\n"),
    }),
  );

  let papersDone = 0;
  let scored = 0;
  let failed = 0;

  onProgress?.({ papersDone: 0, papersTotal: pending.length, passed: 0, callsDone: 0, callsTotal: calls.length, failed: 0 });

  await runPool(agent, prompts, {
    model: cfg.fine.model,
    schema: FINE_SCHEMA,
    maxWorkers: cfg.fine.maxWorkers,
    timeoutMs: cfg.callTimeoutMs,
    retries: cfg.callRetries,
    onAttemptFailed: (error, _index, attempt, totalAttempts) => {
      onCallFailed?.(`attempt ${attempt}/${totalAttempts} failed, retrying — ${error}`);
    },
    onProgress: (output, index, callsDone, callsTotal) => {
      const c = calls[index];
      const entries =
        output && typeof output === "object" && !Array.isArray(output) && !(output instanceof Error)
          ? (output as { papers?: unknown }).papers
          : undefined;

      if (!(output instanceof Error) && Array.isArray(entries)) {
        const byId = new Map<string, FineEntry>();
        for (const entry of entries) {
          if (entry && typeof entry === "object" && "id" in entry) {
            byId.set(String((entry as { id: unknown }).id), entry as FineEntry);
          }
        }

        for (const p of c) {
          const entry = byId.get(p.id);
          if (!entry) continue;
          const score = Number(entry.score);
          if (!Number.isFinite(score)) continue; // garbled score: leave unscored

          p.score = score;
          p.summary = String(entry.summary ?? "");
          p.keyContribution = String(entry.key_contribution ?? "");
          p.whyItMatters = String(entry.why_it_matters ?? "");
          scored++;
        }
      } else {
        // call failed or malformed shape — leave unscored
        failed++;
        onCallFailed?.(output instanceof Error ? output.message : "malformed output shape");
      }

      papersDone += c.length;
      onProgress?.({ papersDone, papersTotal: pending.length, passed: scored, callsDone, callsTotal, failed });
    },
  });
}
