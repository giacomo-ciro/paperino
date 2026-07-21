import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import type { Config, StageConfig } from "./types.js";

export const CONFIG_DIR = join(homedir(), ".paperino");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

const ALLOWED_MODELS = ["fable", "opus", "sonnet", "haiku"];
const ARXIV_CATEGORY_RE = /^[a-z-]+(\.[A-Z]{2,3})?$/;

function expandTilde(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function templatePath(): string {
  return new URL("./bootstrap-config.toml", import.meta.url).pathname;
}

function detectClaudeBinary(): string | null {
  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** `mkdir -p` the config dir and, on first run only, template the config from the bundled default. */
export function ensureConfig(configPath: string = CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) {
    return;
  }

  const template = readFileSync(templatePath(), "utf-8");
  const claudeBinary = detectClaudeBinary();

  const rendered = claudeBinary
    ? template.replace('CLAUDE_BINARY = "claude"', `CLAUDE_BINARY = "${claudeBinary}"`)
    : template;

  if (!claudeBinary) {
    process.stderr.write(
      "warning: claude CLI not found — set RUNTIME.CLAUDE_BINARY in the config once it's installed.\n",
    );
  }

  writeFileSync(configPath, rendered, "utf-8");
}

class ConfigErrorCollector {
  private errors: string[] = [];

  add(message: string): void {
    this.errors.push(message);
  }

  string(table: Record<string, unknown>, key: string, label: string = key): string {
    const value = table[key];
    if (typeof value !== "string") {
      this.add(`"${label}" must be a string`);
      return "";
    }
    return value;
  }

  nonEmptyString(table: Record<string, unknown>, key: string, label: string = key): string {
    const value = this.string(table, key, label);
    if (value.trim() === "") {
      this.add(`"${label}" is empty`);
    }
    return value;
  }

  number(table: Record<string, unknown>, key: string, label: string = key): number {
    const value = table[key];
    if (typeof value !== "number") {
      this.add(`"${label}" must be a number`);
      return 0;
    }
    return value;
  }

  stringArray(table: Record<string, unknown>, key: string, label: string = key): string[] {
    const value = table[key];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      this.add(`"${label}" must be an array of strings`);
      return [];
    }
    return value;
  }

  nonEmptyStringArray(table: Record<string, unknown>, key: string, label: string = key): string[] {
    const value = this.stringArray(table, key, label);
    if (value.length === 0) {
      this.add(`"${label}" is empty`);
    }
    return value;
  }

  /** Number already extracted via `.number()`; checks it satisfies `predicate`, else records `detail`. */
  numberSatisfies(value: number, label: string, predicate: (n: number) => boolean, detail: string): void {
    if (!predicate(value)) {
      this.add(`"${label}" ${detail}`);
    }
  }

  /** String already extracted via `.nonEmptyString()`; checks it's one of `allowed`. */
  oneOf(value: string, allowed: string[], label: string): void {
    if (value !== "" && !allowed.includes(value)) {
      this.add(`"${label}" must be one of: ${allowed.join(", ")} (got "${value}")`);
    }
  }

  /** Every arXiv category must look like "cs.LG" or "stat" (see https://arxiv.org/category_taxonomy). */
  arxivCategories(value: string[], label: string): void {
    for (const cat of value) {
      if (!ARXIV_CATEGORY_RE.test(cat)) {
        this.add(`"${label}" contains "${cat}", which doesn't look like an arXiv category (e.g. "cs.LG")`);
      }
    }
  }

  /** Prompt already extracted via `.nonEmptyString()`; must template both placeholders it's filled with. */
  promptHasPlaceholders(value: string, label: string): void {
    if (value === "") return;
    for (const placeholder of ["{research_interests}", "{papers}"]) {
      if (!value.includes(placeholder)) {
        this.add(`"${label}" is missing the ${placeholder} placeholder`);
      }
    }
  }

  table(table: Record<string, unknown>, key: string, label: string = key): Record<string, unknown> {
    const value = table[key];
    if (typeof value !== "object" || value === null) {
      this.add(`"[${label}]" table is missing`);
      return {};
    }
    return value as Record<string, unknown>;
  }

  stage(stages: Record<string, unknown>, key: string, label: string): StageConfig {
    const stage = this.table(stages, key, label);

    const model = this.nonEmptyString(stage, "MODEL", `${label}.MODEL`);
    this.oneOf(model, ALLOWED_MODELS, `${label}.MODEL`);

    const callSize = this.number(stage, "CALL_SIZE", `${label}.CALL_SIZE`);
    this.numberSatisfies(callSize, `${label}.CALL_SIZE`, (n) => n > 0, "must be a positive number");

    const maxWorkers = this.number(stage, "MAX_WORKERS", `${label}.MAX_WORKERS`);
    this.numberSatisfies(maxWorkers, `${label}.MAX_WORKERS`, (n) => n > 0, "must be a positive number");

    const prompt = this.nonEmptyString(stage, "PROMPT", `${label}.PROMPT`);
    this.promptHasPlaceholders(prompt, `${label}.PROMPT`);

    return { model, callSize, maxWorkers, prompt };
  }

  throwIfAny(configPath: string): void {
    if (this.errors.length === 0) {
      return;
    }
    const list = this.errors.map((e) => `  - ${e}`).join("\n");
    throw new Error(
      `Config error(s) in ${configPath} (run --configure to edit):\n${list}`,
    );
  }
}

/** Load, validate, and map the UPPER_SNAKE_CASE config TOML. */
export function loadConfig(configPath: string = CONFIG_PATH): Config {
  const raw = readFileSync(configPath, "utf-8");
  const table = parse(raw) as Record<string, unknown>;
  const errors = new ConfigErrorCollector();

  const runtime = errors.table(table, "RUNTIME");
  const research = errors.table(table, "RESEARCH");
  const output = errors.table(table, "OUTPUT");
  const stages = errors.table(table, "STAGES");

  const callTimeoutSeconds = errors.number(runtime, "CALL_TIMEOUT_SECONDS", "RUNTIME.CALL_TIMEOUT_SECONDS");
  errors.numberSatisfies(
    callTimeoutSeconds,
    "RUNTIME.CALL_TIMEOUT_SECONDS",
    (n) => n > 0,
    "must be a positive number",
  );

  const callRetries = errors.number(runtime, "CALL_RETRIES", "RUNTIME.CALL_RETRIES");
  errors.numberSatisfies(callRetries, "RUNTIME.CALL_RETRIES", (n) => n >= 0, "must be zero or a positive number");

  const arxivCat = errors.nonEmptyStringArray(research, "ARXIV_CAT", "RESEARCH.ARXIV_CAT");
  errors.arxivCategories(arxivCat, "RESEARCH.ARXIV_CAT");

  const minScore = errors.number(research, "MIN_SCORE", "RESEARCH.MIN_SCORE");
  errors.numberSatisfies(minScore, "RESEARCH.MIN_SCORE", (n) => n >= 1 && n <= 10, "must be between 1 and 10");

  const config: Config = {
    claudeBinary: errors.nonEmptyString(runtime, "CLAUDE_BINARY", "RUNTIME.CLAUDE_BINARY"),
    callTimeoutMs: callTimeoutSeconds * 1000,
    callRetries,
    arxivCat,
    researchInterests: errors.nonEmptyString(research, "RESEARCH_INTERESTS", "RESEARCH.RESEARCH_INTERESTS"),
    minScore,
    outDir: expandTilde(errors.nonEmptyString(output, "OUT_DIR", "OUTPUT.OUT_DIR")),
    logFile: expandTilde(errors.nonEmptyString(output, "LOG_FILE", "OUTPUT.LOG_FILE")),
    coarse: errors.stage(stages, "COARSE", "STAGES.COARSE"),
    fine: errors.stage(stages, "FINE", "STAGES.FINE"),
  };

  errors.throwIfAny(configPath);

  return config;
}

/** Open the config file in the user's editor, falling back to `vi`. */
export function openConfigInEditor(configPath: string = CONFIG_PATH): void {
  const candidates = [process.env.VISUAL, process.env.EDITOR, "vi"].filter(
    (c): c is string => !!c,
  );

  for (const editor of candidates) {
    const result = spawnSync(editor, [configPath], { stdio: "inherit" });
    if (!result.error && result.status === 0) {
      return;
    }
  }

  process.stdout.write(`Could not open an editor. Edit the config file yourself: ${configPath}\n`);
}
