import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { ARXIV_CATEGORY_CODES } from "./arxiv-categories.js";
import { checkWritableDir } from "./store.js";
import { patchTomlValue, removeTomlValue, type TomlValue } from "./toml.js";
import type { AgentProvider, Config, EmailConfig, StageConfig } from "./types.js";

export const CONFIG_DIR = join(homedir(), ".paperino");
export const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

/** The models each provider may be pointed at. Single source of truth for the wizard too. */
export const AGENT_MODELS: Record<AgentProvider, string[]> = {
  claude: ["fable", "opus", "sonnet", "haiku"],
  codex: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
};
const AGENT_PROVIDERS: AgentProvider[] = ["claude", "codex"];
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function expandTilde(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function templatePath(): string {
  return new URL("./bootstrap-config.toml", import.meta.url).pathname;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Add missing template values to an existing config without replacing user values. */
function addMissingDefaults(source: string, config: Record<string, unknown>, defaults: Record<string, unknown>, table = ""): string {
  let updated = source;
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const value = config[key];
    const path = table ? `${table}.${key}` : key;
    if (value === undefined) {
      if (isTable(defaultValue)) {
        updated = addMissingDefaults(updated, {}, defaultValue, path);
      } else {
        updated = patchTomlValue(updated, table, key, defaultValue as TomlValue);
      }
    } else if (isTable(value) && isTable(defaultValue)) {
      updated = addMissingDefaults(updated, value, defaultValue, path);
    }
  }
  return updated;
}

function detectBinary(name: string): string | null {
  try {
    const resolved = execFileSync("which", [name], { encoding: "utf-8" }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

export function detectClaudeBinary(): string | null {
  return detectBinary("claude");
}

export function detectCodexBinary(): string | null {
  return detectBinary("codex");
}

/** `mkdir -p` the config dir and fill any missing values from the bundled default. */
export function ensureConfig(configPath: string = CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const template = readFileSync(templatePath(), "utf-8");
  if (existsSync(configPath)) {
    const source = readFileSync(configPath, "utf-8");
    const config = parse(source) as Record<string, unknown>;
    const defaults = parse(template) as Record<string, unknown>;
    const runtime = isTable(config.RUNTIME) ? config.RUNTIME : {};
    const stages = isTable(config.STAGES) ? config.STAGES : {};
    const coarse = isTable(stages.COARSE) ? stages.COARSE : {};

    let updated = source;
    //backward compatibility for legacy config with max workers splitted per stage
    if (runtime.MAX_WORKERS === undefined && typeof coarse.MAX_WORKERS === "number") {
      updated = patchTomlValue(updated, "RUNTIME", "MAX_WORKERS", coarse.MAX_WORKERS);
      updated = removeTomlValue(removeTomlValue(updated, "STAGES.COARSE", "MAX_WORKERS"), "STAGES.FINE", "MAX_WORKERS");
    }
    // A key filled from the template arrives as the bare command name; resolve it the way a
    // fresh config does, so a config migrated onto codex still resolves under cron's PATH.
    for (const [key, detect] of [["CLAUDE_BINARY", detectClaudeBinary], ["CODEX_BINARY", detectCodexBinary]] as const) {
      if (runtime[key] !== undefined) continue;
      const detected = detect();
      if (detected) updated = patchTomlValue(updated, "RUNTIME", key, detected);
    }
    updated = addMissingDefaults(updated, parse(updated) as Record<string, unknown>, defaults);
    if (updated !== source) writeFileSync(configPath, updated, "utf-8");
    return;
  }

  const claudeBinary = detectClaudeBinary();
  const codexBinary = detectCodexBinary();

  let rendered = template;
  if (claudeBinary) rendered = rendered.replace('CLAUDE_BINARY = "claude"', `CLAUDE_BINARY = "${claudeBinary}"`);
  if (codexBinary) rendered = rendered.replace('CODEX_BINARY = "codex"', `CODEX_BINARY = "${codexBinary}"`);

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

  /**
   * Path already tilde-expanded; must be absolute. A relative path would resolve
   * against the cwd, so `paperino` would read/write different places depending on
   * where it was launched from (notably under cron).
   */
  absolutePath(value: string, label: string): void {
    if (value !== "" && !isAbsolute(value)) {
      this.add(`"${label}" must be an absolute path or start with "~" (got "${value}")`);
    }
  }

  /**
   * Path already checked absolute; confirms we can actually create files there, so
   * an unwritable dir fails now rather than after a run has spent model calls.
   */
  writableDir(dir: string, label: string): void {
    // Skip when absent or already flagged relative — don't create dirs off the cwd.
    if (dir === "" || !isAbsolute(dir)) return;
    const problem = checkWritableDir(dir);
    if (problem) {
      this.add(`"${label}" is not writable: ${problem}`);
    }
  }

  /**
   * Binary path already extracted; if it's absolute, confirm it still exists. Version
   * managers move these when Node is upgraded, and without this the run fails one spawn
   * at a time — burning every retry before producing an empty digest. A bare command name
   * is left to resolve against PATH at spawn time.
   */
  existingBinary(value: string, label: string): void {
    if (value === "" || !isAbsolute(value) || existsSync(value)) return;
    this.add(`"${label}" no longer exists: ${value}`);
  }

  /** String already extracted via `.nonEmptyString()`; checks it's one of `allowed`. */
  oneOf(value: string, allowed: string[], label: string): void {
    if (value !== "" && !allowed.includes(value)) {
      this.add(`"${label}" must be one of: ${allowed.join(", ")} (got "${value}")`);
    }
  }

  emailAddress(value: string, label: string): void {
    if (value !== "" && !EMAIL_ADDRESS_RE.test(value)) {
      this.add(`"${label}" must be a valid email address`);
    }
  }

  /** Every arXiv category must be a real category from the taxonomy (see https://arxiv.org/category_taxonomy). */
  arxivCategories(value: string[], label: string): void {
    for (const cat of value) {
      if (!ARXIV_CATEGORY_CODES.has(cat)) {
        this.add(`"${label}" contains "${cat}", which isn't a real arXiv category (e.g. "cs.LG") — see https://arxiv.org/category_taxonomy`);
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

  stage(
    stages: Record<string, unknown>,
    key: string,
    label: string,
    maxWorkers: number,
    agent: AgentProvider,
  ): StageConfig {
    const stage = this.table(stages, key, label);

    const model = this.nonEmptyString(stage, "MODEL", `${label}.MODEL`);
    this.oneOf(model, AGENT_MODELS[agent], `${label}.MODEL`);

    const callSize = this.number(stage, "CALL_SIZE", `${label}.CALL_SIZE`);
    this.numberSatisfies(callSize, `${label}.CALL_SIZE`, (n) => n > 0, "must be a positive number");

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
      `Config error(s) in ${configPath} (run --configure to update it):\n${list}`,
    );
  }
}

/** Load, validate, and map the UPPER_SNAKE_CASE config TOML. */
export function loadConfig(configPath: string = CONFIG_PATH): Config {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as Record<string, unknown>;
  const table = parsed;
  const errors = new ConfigErrorCollector();

  const runtime = errors.table(table, "RUNTIME");
  const research = errors.table(table, "RESEARCH");
  const output = errors.table(table, "OUTPUT");
  const stages = errors.table(table, "STAGES");
  const emailTable = table.EMAIL;

  const callTimeoutSeconds = errors.number(runtime, "CALL_TIMEOUT_SECONDS", "RUNTIME.CALL_TIMEOUT_SECONDS");
  errors.numberSatisfies(
    callTimeoutSeconds,
    "RUNTIME.CALL_TIMEOUT_SECONDS",
    (n) => n > 0,
    "must be a positive number",
  );

  const callRetries = errors.number(runtime, "CALL_RETRIES", "RUNTIME.CALL_RETRIES");
  errors.numberSatisfies(callRetries, "RUNTIME.CALL_RETRIES", (n) => n >= 0, "must be zero or a positive number");

  const maxWorkers = errors.number(runtime, "MAX_WORKERS", "RUNTIME.MAX_WORKERS");
  errors.numberSatisfies(maxWorkers, "RUNTIME.MAX_WORKERS", (n) => n > 0, "must be a positive number");

  const agentValue = errors.nonEmptyString(runtime, "AGENT", "RUNTIME.AGENT");
  errors.oneOf(agentValue, AGENT_PROVIDERS, "RUNTIME.AGENT");
  const agent: AgentProvider = agentValue === "codex" ? "codex" : "claude";

  const arxivCat = errors.nonEmptyStringArray(research, "ARXIV_CAT", "RESEARCH.ARXIV_CAT");
  errors.arxivCategories(arxivCat, "RESEARCH.ARXIV_CAT");

  const minScore = errors.number(research, "MIN_SCORE", "RESEARCH.MIN_SCORE");
  errors.numberSatisfies(minScore, "RESEARCH.MIN_SCORE", (n) => n >= 1 && n <= 10, "must be between 1 and 10");

  const cacheDir = expandTilde(errors.nonEmptyString(output, "CACHE_DIR", "OUTPUT.CACHE_DIR"));
  errors.absolutePath(cacheDir, "OUTPUT.CACHE_DIR");
  errors.writableDir(cacheDir, "OUTPUT.CACHE_DIR");

  const outDir = expandTilde(errors.nonEmptyString(output, "OUT_DIR", "OUTPUT.OUT_DIR"));
  errors.absolutePath(outDir, "OUTPUT.OUT_DIR");
  errors.writableDir(outDir, "OUTPUT.OUT_DIR");

  const logFile = expandTilde(errors.nonEmptyString(output, "LOG_FILE", "OUTPUT.LOG_FILE"));
  errors.absolutePath(logFile, "OUTPUT.LOG_FILE");
  errors.writableDir(dirname(logFile), "OUTPUT.LOG_FILE");

  let email: EmailConfig | undefined;
  if (emailTable !== undefined) {
    if (typeof emailTable !== "object" || emailTable === null) {
      errors.add('"[EMAIL]" must be a table');
    } else {
      const table = emailTable as Record<string, unknown>;
      const senderAddress = errors.string(table, "SENDER_ADDRESS", "EMAIL.SENDER_ADDRESS");
      const recipientAddress = errors.string(table, "RECIPIENT_ADDRESS", "EMAIL.RECIPIENT_ADDRESS");
      const appPassword = errors.string(table, "APP_PASSWORD", "EMAIL.APP_PASSWORD");
      const configured = [senderAddress, recipientAddress, appPassword].some((value) => value !== "");

      if (configured) {
        if (senderAddress === "") errors.add('"EMAIL.SENDER_ADDRESS" is empty');
        if (recipientAddress === "") errors.add('"EMAIL.RECIPIENT_ADDRESS" is empty');
        if (appPassword === "") errors.add('"EMAIL.APP_PASSWORD" is empty');
        errors.emailAddress(senderAddress, "EMAIL.SENDER_ADDRESS");
        errors.emailAddress(recipientAddress, "EMAIL.RECIPIENT_ADDRESS");
        email = { senderAddress, recipientAddress, appPassword };
      }
    }
  }

  const claudeBinary = errors.nonEmptyString(runtime, "CLAUDE_BINARY", "RUNTIME.CLAUDE_BINARY");
  const codexBinary = errors.nonEmptyString(runtime, "CODEX_BINARY", "RUNTIME.CODEX_BINARY");
  // Only the agent actually in use has to resolve — the other CLI may simply not be installed.
  if (agent === "claude") errors.existingBinary(claudeBinary, "RUNTIME.CLAUDE_BINARY");
  else errors.existingBinary(codexBinary, "RUNTIME.CODEX_BINARY");

  const config: Config = {
    agent,
    claudeBinary,
    codexBinary,
    callTimeoutMs: callTimeoutSeconds * 1000,
    callRetries,
    arxivCat,
    researchInterests: errors.nonEmptyString(research, "RESEARCH_INTERESTS", "RESEARCH.RESEARCH_INTERESTS"),
    minScore,
    cacheDir,
    outDir,
    logFile,
    email,
    coarse: errors.stage(stages, "COARSE", "STAGES.COARSE", maxWorkers, agent),
    fine: errors.stage(stages, "FINE", "STAGES.FINE", maxWorkers, agent),
  };

  errors.throwIfAny(configPath);

  return config;
}
