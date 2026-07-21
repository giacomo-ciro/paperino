import type { Agent, AgentOutput, JsonSchema } from "../types.js";

export interface RunPoolOptions {
  model: string;
  schema: JsonSchema;
  maxWorkers: number;
  timeoutMs: number;
  retries: number; // retries after the first attempt
  /** Called after each prompt settles, with its index/result and the count completed so far. */
  onProgress?: (result: AgentOutput | Error, index: number, completed: number, total: number) => void;
  /** Called after each failed attempt that will still be retried (not the final one). */
  onAttemptFailed?: (error: string, index: number, attempt: number, totalAttempts: number) => void;
}

async function runOnce(agent: Agent, prompt: string, opts: RunPoolOptions): Promise<AgentOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const { output } = await agent.run(prompt, {
      model: opts.model,
      schema: opts.schema,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
    });
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function runWithRetries(
  agent: Agent,
  prompt: string,
  index: number,
  opts: RunPoolOptions,
): Promise<AgentOutput | Error> {
  const totalAttempts = opts.retries + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await runOnce(agent, prompt, opts);
    } catch (err) {
      lastError = err;
      if (attempt < totalAttempts) {
        opts.onAttemptFailed?.(err instanceof Error ? err.message : String(err), index, attempt, totalAttempts);
      }
    }
  }
  return lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Fan `prompts` out over a concurrency-limited pool. Returns one entry per prompt,
 * in order: the parsed output, or an Error if that prompt ultimately failed after
 * retries (so one bad call can't abort the run).
 */
export async function runPool(
  agent: Agent,
  prompts: string[],
  opts: RunPoolOptions,
): Promise<(AgentOutput | Error)[]> {
  const results: (AgentOutput | Error)[] = new Array(prompts.length);
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= prompts.length) return;
      const result = await runWithRetries(agent, prompts[index], index, opts);
      results[index] = result;
      completed++;
      opts.onProgress?.(result, index, completed, prompts.length);
    }
  }

  const workerCount = Math.min(opts.maxWorkers, prompts.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
