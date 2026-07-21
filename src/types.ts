export interface Paper {
  id: string; // short id "2601.02594v1" (URL-prefix stripped; "/"→"_")
  title: string;
  abstract: string; // arXiv <summary>
  link: string; // <id> abs URL
  categories: string[];
  published: string; // ISO 8601
  journalRef: string | null;
  comment: string | null;
  coarse?: 0 | 1; // presence == already screened
  score?: number; // 1..10; presence == already scored
  summary?: string;
  keyContribution?: string;
  whyItMatters?: string;
}

export interface StageConfig {
  model: string;
  callSize: number;
  maxWorkers: number;
  prompt: string;
}

export interface Config {
  claudeBinary: string;
  arxivCat: string[];
  researchInterests: string;
  minScore: number;
  outDir: string; // ~-expanded absolute
  logFile: string; // ~-expanded absolute; always appended to
  callTimeoutMs: number; // per claude call timeout (config: RUNTIME.CALL_TIMEOUT_SECONDS → ms)
  callRetries: number; // retries after the first attempt (config: RUNTIME.CALL_RETRIES)
  coarse: StageConfig; // title-only screening pass; coarse.prompt drives it
  fine: StageConfig; // title+abstract scoring pass; fine.prompt drives it
  // NOTE: no email.* keys in this port — email is deferred.
}

export type JsonSchema = Record<string, unknown>;
export type AgentOutput = unknown; // coarse: Record<string,0|1>; fine: FineEntry[]

// cwd dropped: the agent ALWAYS runs in os.tmpdir() (neutral CWD). timeoutMs/retries come from config.
export interface AgentRunOptions {
  model: string;
  schema: JsonSchema;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  output: AgentOutput;
}

export interface Agent {
  readonly name: string;
  run(prompt: string, opts: AgentRunOptions): Promise<AgentResult>;
}

export interface FineEntry {
  id: string;
  score: number;
  summary: string;
  key_contribution: string;
  why_it_matters: string;
}
