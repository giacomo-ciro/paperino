import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { parse } from "smol-toml";
import { ARXIV_CATEGORY_CODES } from "./arxiv-categories.js";
import { CONFIG_PATH, detectClaudeBinary, detectCodexBinary } from "./config.js";
import { sendTestEmail } from "./email.js";
import { checkWritableDir } from "./store.js";
import { patchTomlValue, removeTomlValue } from "./toml.js";
import type { AgentProvider } from "./types.js";

const ALLOWED_MODELS = ["fable", "opus", "sonnet", "haiku"];
const TOTAL_STEPS = 7;
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUMMARY_LABEL_WIDTH = 20;

const COMMON_CATEGORIES: { code: string; name: string }[] = [
  { code: "cs.CV", name: "Computer Vision" },
  { code: "cs.LG", name: "Machine Learning" },
  { code: "cs.CL", name: "Computation and Language (NLP)" },
  { code: "cs.AI", name: "Artificial Intelligence" },
  { code: "cs.RO", name: "Robotics" },
  { code: "stat.ML", name: "Statistics — Machine Learning" },
];

const CATEGORY_ERROR =
  "not a real arXiv category — see the list above, or the full taxonomy at https://arxiv.org/category_taxonomy";

/** Validator returns an error string if invalid, or null if the value is OK. */
type Validator = (value: string) => string | null;

/** Checks every comma-separated code against the real taxonomy. */
function validateCategories(raw: string): string | null {
  const cats = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (cats.length === 0) return CATEGORY_ERROR;
  const bad = cats.filter((c) => !ARXIV_CATEGORY_CODES.has(c));
  if (bad.length > 0) return CATEGORY_ERROR;
  return null;
}

/**
 * Rejects relative paths (they'd resolve against wherever paperino was launched
 * from) and paths we couldn't actually write to, so a bad answer is caught here
 * rather than crashing the first real run.
 */
function validateOutDir(value: string): string | null {
  if (!value.startsWith("~") && !isAbsolute(value)) {
    return 'must be an absolute path, or start with "~" for your home directory';
  }
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
  const problem = checkWritableDir(expanded);
  return problem ? `can't write there: ${problem}` : null;
}

function validateEmailAddress(value: string): string | null {
  return EMAIL_ADDRESS_RE.test(value) ? null : "must be a valid email address";
}

function validateAppPassword(value: string): string | null {
  return /^[a-zA-Z0-9]{16}$/.test(value.replace(/\s/g, ""))
    ? null
    : "must be a 16-character Google app password";
}

/** Positive-integer validator, optionally bounded. */
function positiveInteger(label: string, opts: { min?: number; max?: number } = {}): Validator {
  return (value: string) => {
    if (!/^\d+$/.test(value)) return `${label} must be a positive whole number`;
    const n = Number.parseInt(value, 10);
    if (opts.min !== undefined && n < opts.min) return `${label} must be at least ${opts.min}`;
    if (opts.max !== undefined && n > opts.max) return `${label} must be at most ${opts.max}`;
    return null;
  };
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function summaryLine(label: string, value: string): void {
  say(`${pc.dim(label.padEnd(SUMMARY_LABEL_WIDTH))}${value}`);
}

function heading(step: number, text: string): void {
  process.stdout.write(`\n${pc.bold(`${step}/${TOTAL_STEPS} ${text}`)}\n`);
}

interface Answers {
  agent: AgentProvider;
  researchInterests: string;
  arxivCat: string[];
  outDir: string;
  coarseModel: string;
  fineModel: string;
  coarseCallSize: number;
  fineCallSize: number;
  maxWorkers: number;
  senderAddress: string;
  recipientAddress: string;
  appPassword: string;
}

type TomlTable = Record<string, unknown>;

function tableValue(config: TomlTable, name: string): TomlTable {
  const value = config[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as TomlTable : {};
}

function stringValue(table: TomlTable, name: string, fallback: string): string {
  return typeof table[name] === "string" ? table[name] : fallback;
}

function numberValue(table: TomlTable, name: string, fallback: number): number {
  return typeof table[name] === "number" ? table[name] : fallback;
}

function stringArrayValue(table: TomlTable, name: string, fallback: string[]): string[] {
  const value = table[name];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

export function patchConfigureAnswers(source: string, answers: Answers): string {
  const replacements: Array<[string, string, string | number | string[]]> = [
    ["RUNTIME", "AGENT", answers.agent],
    ["RESEARCH", "ARXIV_CAT", answers.arxivCat],
    ["RESEARCH", "RESEARCH_INTERESTS", answers.researchInterests],
    ["OUTPUT", "OUT_DIR", answers.outDir],
    ["STAGES.COARSE", "MODEL", answers.coarseModel],
    ["STAGES.COARSE", "CALL_SIZE", answers.coarseCallSize],
    ["STAGES.FINE", "MODEL", answers.fineModel],
    ["STAGES.FINE", "CALL_SIZE", answers.fineCallSize],
    ["RUNTIME", "MAX_WORKERS", answers.maxWorkers],
    ["EMAIL", "SENDER_ADDRESS", answers.senderAddress],
    ["EMAIL", "RECIPIENT_ADDRESS", answers.recipientAddress],
    ["EMAIL", "APP_PASSWORD", answers.appPassword],
  ];
  const patched = replacements.reduce((current, [table, key, value]) => patchTomlValue(current, table, key, value), source);
  return removeTomlValue(removeTomlValue(patched, "STAGES.COARSE", "MAX_WORKERS"), "STAGES.FINE", "MAX_WORKERS");
}

export function emailSettingsChanged(previous: Pick<Answers, "senderAddress" | "recipientAddress" | "appPassword">, next: Pick<Answers, "senderAddress" | "recipientAddress" | "appPassword">): boolean {
  return previous.senderAddress !== next.senderAddress ||
    previous.recipientAddress !== next.recipientAddress ||
    previous.appPassword !== next.appPassword;
}

/** Interactive configuration wizard. Writes ~/.paperino/config.toml only after the final confirmation. */
export async function runConfigure(configPath: string = CONFIG_PATH): Promise<void> {
  const templatePath = new URL("./bootstrap-config.toml", import.meta.url).pathname;
  const templateSource = readFileSync(templatePath, "utf-8");
  const template = parse(templateSource) as TomlTable;
  const exists = existsSync(configPath);
  const source = exists ? readFileSync(configPath, "utf-8") : templateSource;
  const config = parse(source) as TomlTable;
  const research = tableValue(config, "RESEARCH");
  const templateResearch = tableValue(template, "RESEARCH");
  const output = tableValue(config, "OUTPUT");
  const templateOutput = tableValue(template, "OUTPUT");
  const stages = tableValue(config, "STAGES");
  const templateStages = tableValue(template, "STAGES");
  const coarse = tableValue(stages, "COARSE");
  const templateCoarse = tableValue(templateStages, "COARSE");
  const fine = tableValue(stages, "FINE");
  const templateFine = tableValue(templateStages, "FINE");
  const existingEmail = tableValue(config, "EMAIL");
  const templateEmail = tableValue(template, "EMAIL");
  const runtime = tableValue(config, "RUNTIME");
  const templateRuntime = tableValue(template, "RUNTIME");
  const initial = {
    agent: stringValue(runtime, "AGENT", stringValue(templateRuntime, "AGENT", "claude")) === "codex"
      ? "codex" as const
      : "claude" as const,
    researchInterests: stringValue(research, "RESEARCH_INTERESTS", stringValue(templateResearch, "RESEARCH_INTERESTS", "")),
    arxivCat: stringArrayValue(research, "ARXIV_CAT", stringArrayValue(templateResearch, "ARXIV_CAT", [])),
    outDir: stringValue(output, "OUT_DIR", stringValue(templateOutput, "OUT_DIR", "~/paperino/digests")),
    coarseModel: stringValue(coarse, "MODEL", stringValue(templateCoarse, "MODEL", "haiku")),
    fineModel: stringValue(fine, "MODEL", stringValue(templateFine, "MODEL", "sonnet")),
    coarseCallSize: numberValue(coarse, "CALL_SIZE", numberValue(templateCoarse, "CALL_SIZE", 20)),
    fineCallSize: numberValue(fine, "CALL_SIZE", numberValue(templateFine, "CALL_SIZE", 5)),
    maxWorkers: numberValue(
      runtime,
      "MAX_WORKERS",
      numberValue(coarse, "MAX_WORKERS", numberValue(templateRuntime, "MAX_WORKERS", 10)),
    ),
    senderAddress: stringValue(existingEmail, "SENDER_ADDRESS", stringValue(templateEmail, "SENDER_ADDRESS", "")),
    recipientAddress: stringValue(existingEmail, "RECIPIENT_ADDRESS", stringValue(templateEmail, "RECIPIENT_ADDRESS", "")),
    appPassword: stringValue(existingEmail, "APP_PASSWORD", stringValue(templateEmail, "APP_PASSWORD", "")),
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  async function ask(question: string, fallback: string, validate?: Validator): Promise<string> {
    const hint = fallback ? ` (${pc.reset(fallback)})` : "";
    for (;;) {
      const answer = (await rl.question(`${pc.cyan("›")} ${pc.dim(question)}${hint}${pc.dim(":")} `)).trim();
      const value = answer === "" ? fallback : answer;
      const error = validate?.(value);
      if (!error) return value;
      say(pc.yellow(`  ${error}`));
    }
  }

  async function askChoice(question: string, choices: string[], fallback: string): Promise<string> {
    const list = choices.map((c) => (c === fallback ? pc.reset(c) : pc.dim(c))).join(pc.dim(" / "));
    for (;;) {
      const answer = (
        await rl.question(`${pc.cyan("›")} ${pc.dim(question)} ${pc.dim("[")}${list}${pc.dim("]")} `)
      ).trim();
      const value = answer === "" ? fallback : answer;
      if (choices.includes(value)) return value;
      say(pc.yellow(`  must be one of: ${choices.join(", ")}`));
    }
  }

  process.stdout.write("\n");
  say(pc.bold("Welcome to paperino."));
  say("");
  say("Every day, paperino turns newly published arXiv papers into a digest of");
  say("what's actually relevant to your research:");
  say("");
  say(`  ${pc.dim("Step 1")} Fetch ${pc.dim("— get newly published papers in your arXiv categories")}`);
  say(`  ${pc.dim("Step 2")} Coarse filter ${pc.dim("— screen every title with a cheap, fast model")}`);
  say(`  ${pc.dim("Step 3")} Fine filter ${pc.dim("— score the survivors on title + abstract")}`);
  say("");
  say("The result lands in an HTML digest you open locally.");
  say("");
  say(pc.dim("Press Enter to accept a default shown in parentheses, or type your own answer."));

  // ---- Step 1: research interests ----
  heading(1, "What are you working on?");
  say(pc.dim("This is templated into the prompt your agent uses to judge relevance —"));
  say(pc.dim("be specific: methods, problem, domain. A couple of sentences is enough."));
  say("");
  const researchInterests = await ask("Describe your research", initial.researchInterests, (value) =>
    value === "" ? "required — paperino can't filter papers without this." : null,
  );

  // ---- Step 2: arXiv categories ----
  heading(2, "Which arXiv categories should paperino fetch from?");
  say(pc.dim("One is enough to start. Comma-separated for more than one."));
  say(pc.dim("Full taxonomy: https://arxiv.org/category_taxonomy"));
  say("");
  for (const cat of COMMON_CATEGORIES) {
    say(`  ${cat.code.padEnd(8)} ${pc.dim(`(${cat.name})`)}`);
  }
  say("");
  const arxivCatRaw = await ask("Category codes (comma-separated)", initial.arxivCat.join(", "), validateCategories);
  const arxivCat = arxivCatRaw.split(",").map((s) => s.trim()).filter(Boolean);

  // ---- Step 3: output directory ----
  heading(3, "Where should the digests go?");
  say(pc.dim("Each run writes one file, <dir>/YYYY-MM-DD.html, so they sit side by side."));
  say(pc.dim("Pick somewhere you'll actually look. Must be an absolute path (~ is fine)."));
  say("");
  const outDir = await ask("Digest directory", initial.outDir, validateOutDir);

  // ---- Step 4: models ----
  heading(4, "Models");
  say(pc.dim("Coarse pass screens every paper by title alone (cheap/fast model)."));
  say(pc.dim("Fine pass scores only what survives, reading title + abstract (stronger model)."));
  say("");
  const agent = await askChoice("Agent", ["claude", "codex"], initial.agent) as AgentProvider;
  const keepingProvider = agent === initial.agent;
  const coarseFallback = keepingProvider ? initial.coarseModel : agent === "codex" ? "gpt-5.6-luna" : "haiku";
  const fineFallback = keepingProvider ? initial.fineModel : agent === "codex" ? "gpt-5.6-terra" : "sonnet";
  const coarseModel = agent === "claude"
    ? await askChoice("Coarse model", ALLOWED_MODELS, coarseFallback)
    : await ask("Coarse model", coarseFallback, (value) => value === "" ? "required" : null);
  const fineModel = agent === "claude"
    ? await askChoice("Fine model", ALLOWED_MODELS, fineFallback)
    : await ask("Fine model", fineFallback, (value) => value === "" ? "required" : null);

  // ---- Step 5: batch size ----
  heading(5, "Batch size");
  say(pc.dim("How many papers go into a single agent call — coarse reads titles only,"));
  say(pc.dim("fine reads title + abstract, so it uses smaller batches."));
  say("");
  const coarseCallSizeRaw = await ask(
    "Papers per coarse (titles) call",
    String(initial.coarseCallSize),
    positiveInteger("Papers per coarse call", { min: 1 }),
  );
  const fineCallSizeRaw = await ask(
    "Papers per fine (title+abstract) call",
    String(initial.fineCallSize),
    positiveInteger("Papers per fine call", { min: 1 }),
  );
  const coarseCallSize = Number.parseInt(coarseCallSizeRaw, 10);
  const fineCallSize = Number.parseInt(fineCallSizeRaw, 10);

  // ---- Step 6: concurrency ----
  heading(6, "Concurrency");
  say(pc.dim("How many calls run at once. Higher is faster but uses more"));
  say(pc.dim("system resources on your machine."));
  say("");
  const maxWorkersRaw = await ask("Concurrent calls", String(initial.maxWorkers), positiveInteger("Concurrent calls", { min: 1 }));
  const maxWorkers = Number.parseInt(maxWorkersRaw, 10);

  // ---- Step 7: email delivery ----
  heading(7, "Email delivery (optional)");
  say(pc.dim("Use a Gmail app password to email each digest when you run paperino --email."));
  if (initial.senderAddress === "") {
    say(pc.dim("Leave the sender address blank to skip this. The app password is stored in plain text."));
  } else {
    say(pc.dim("The app password is stored in plain text."));
  }
  say("");
  let senderAddress = initial.senderAddress;
  let recipientAddress = initial.recipientAddress;
  let appPassword = initial.appPassword;
  for (;;) {
    senderAddress = await ask(
      initial.senderAddress === ""
        ? "Google sender address (leave blank to skip)"
        : "Google sender address",
      initial.senderAddress,
      (value) => value === "" ? null : validateEmailAddress(value),
    );
    if (senderAddress === "") {
      recipientAddress = "";
      appPassword = "";
      break;
    }

    recipientAddress = await ask("Digest recipient address", initial.recipientAddress, validateEmailAddress);
    appPassword = await ask("Google app password (16 characters; whitespace removed)", initial.appPassword, validateAppPassword);
    appPassword = appPassword.replace(/\s/g, "");

    const emailChanged = emailSettingsChanged(initial, { senderAddress, recipientAddress, appPassword });
    if (!emailChanged) break;

    say("");
    say(pc.dim(`Sending a test email to ${recipientAddress}…`));
    try {
      await sendTestEmail({ senderAddress, recipientAddress, appPassword });
      const received = (await rl.question(`${pc.cyan("›")} ${pc.dim(`Did you receive the test email at ${recipientAddress}? (y/N)`)} `))
        .trim()
        .toLowerCase();
      if (received !== "y" && received !== "yes") {
        say(pc.yellow("  Let's try again."));
        continue;
      }
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      say(pc.yellow(`  Test email failed: ${message}`));
    }
  }

  // ---- Confirmation before writing anything ----
  say(`\n${pc.bold("Ready to save your config")}`);
  say("");
  summaryLine("Research interests", researchInterests);
  summaryLine("arXiv categories", arxivCat.join(", "));
  summaryLine("Digest directory", outDir);
  summaryLine("Agent", agent);
  summaryLine("Coarse model", `${coarseModel} (${coarseCallSize} papers/call)`);
  summaryLine("Fine model", `${fineModel} (${fineCallSize} papers/call)`);
  summaryLine("Concurrency", `${maxWorkers} concurrent calls`);
  if (senderAddress !== "") {
    summaryLine("Email sender", senderAddress);
    summaryLine("Email recipient", recipientAddress);
    summaryLine("Email app password", "configured");
  } else {
    summaryLine("Email delivery", "disabled");
  }
  say("");
  say(pc.dim(`This will be written to ${configPath}`));
  say("");

  const confirm = (await rl.question(`${pc.dim("Press Enter to save (any other key to cancel)")} `)).trim();
  rl.close();

  if (confirm !== "") {
    say(pc.yellow("\nCancelled — no config was written."));
    return;
  }

  let rendered = patchConfigureAnswers(source, {
    agent,
    researchInterests,
    arxivCat,
    outDir,
    coarseModel,
    fineModel,
    coarseCallSize,
    fineCallSize,
    maxWorkers,
    senderAddress,
    recipientAddress,
    appPassword,
  });

  if (!exists) {
    const claudeBinary = detectClaudeBinary();
    const codexBinary = detectCodexBinary();
    if (claudeBinary) {
      rendered = patchTomlValue(rendered, "RUNTIME", "CLAUDE_BINARY", claudeBinary);
    }
    if (codexBinary) rendered = patchTomlValue(rendered, "RUNTIME", "CODEX_BINARY", codexBinary);
    const selectedBinary = agent === "claude" ? claudeBinary : codexBinary;
    if (!selectedBinary) {
      const key = agent === "claude" ? "CLAUDE_BINARY" : "CODEX_BINARY";
      process.stderr.write(
        `warning: ${agent} CLI not found — set RUNTIME.${key} in the config once it's installed.\n`,
      );
    }
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, rendered, "utf-8");
  chmodSync(configPath, 0o600);

  say(
    pc.green("\n✓ Config saved.") +
      pc.dim(" Run ") +
      "paperino" +
      pc.dim(" to start, or ") +
      "paperino --configure" +
      pc.dim(" to fine-tune it further."),
  );

  say(`\n${pc.bold("A few commands to try:")}`);
  say("");
  say(`  ${pc.cyan("paperino")}`);
  say(pc.dim("    process the latest arXiv announcement"));
  say("");
  say(`  ${pc.cyan("paperino --last 3")}`);
  say(pc.dim("    catch up on the latest 3 arXiv announcements"));
  say("");
  say(`  ${pc.cyan("paperino --max-papers 50")}`);
  say(pc.dim("    cap each announcement at 50 papers (most recently submitted first)"));
  say("");
  say(`  ${pc.cyan("paperino --only-fetch")}`);
  say(pc.dim("    fetch papers without running the coarse/fine scoring pipeline"));
  say("");
  say(`  ${pc.cyan("paperino --email")}`);
  say(pc.dim("    email each completed digest to the configured recipient"));
  say("");
  say(`  ${pc.cyan("paperino --logs")}`);
  say(pc.dim("    tail the log file — useful after a run reports failed calls"));
  say("");
  say(`  ${pc.cyan("paperino --quiet")}`);
  say(pc.dim("    run non-interactively and only print the digest path — what a cron job wants"));
}
