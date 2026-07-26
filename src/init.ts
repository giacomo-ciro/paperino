import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { ARXIV_CATEGORY_CODES } from "./arxiv-categories.js";
import { CONFIG_PATH, detectClaudeBinary } from "./config.js";
import { checkWritableDir } from "./store.js";

const ALLOWED_MODELS = ["fable", "opus", "sonnet", "haiku"];
const TOTAL_STEPS = 6;

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

function heading(step: number, text: string): void {
  process.stdout.write(`\n${pc.bold(`${step}/${TOTAL_STEPS} ${text}`)}\n`);
}

interface Answers {
  researchInterests: string;
  arxivCat: string[];
  outDir: string;
  coarseModel: string;
  fineModel: string;
  coarseCallSize: number;
  fineCallSize: number;
  maxWorkers: number;
}

/** Fills the bootstrap template's placeholders with the wizard's answers, preserving all comments. */
function renderConfig(template: string, a: Answers): string {
  const arxivCatToml = a.arxivCat.map((c) => `"${c}"`).join(", ");

  let rendered = template
    .replace("ARXIV_CAT = []", `ARXIV_CAT = [${arxivCatToml}]`)
    .replace('RESEARCH_INTERESTS = """\n"""', `RESEARCH_INTERESTS = """\n${a.researchInterests}\n"""`)
    .replace('OUT_DIR = "~/paperino/digests"', `OUT_DIR = "${a.outDir}"`);

  const stageBlock = (name: "COARSE" | "FINE", model: string, callSize: number): [RegExp, string] => [
    new RegExp(`(\\[STAGES\\.${name}\\]\\nMODEL = )"[^"]+"( # one of: fable, opus, sonnet, haiku\\nCALL_SIZE = )\\d+`),
    `$1"${model}"$2${callSize}`,
  ];

  const [coarseRe, coarseRepl] = stageBlock("COARSE", a.coarseModel, a.coarseCallSize);
  const [fineRe, fineRepl] = stageBlock("FINE", a.fineModel, a.fineCallSize);
  rendered = rendered.replace(coarseRe, coarseRepl).replace(fineRe, fineRepl);

  rendered = rendered.replaceAll("MAX_WORKERS = 10 # concurrent calls", `MAX_WORKERS = ${a.maxWorkers} # concurrent calls`);

  return rendered;
}

/** Interactive setup wizard. Writes ~/.paperino/config.toml only after the final confirmation. */
export async function runInit(configPath: string = CONFIG_PATH): Promise<void> {
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

  async function askRequired(question: string, validate?: Validator): Promise<string> {
    for (;;) {
      const answer = (await rl.question(`${pc.cyan("›")} ${pc.dim(question)} `)).trim();
      if (answer === "") {
        say(pc.yellow("  required — paperino can't filter papers without this."));
        continue;
      }
      const error = validate?.(answer);
      if (!error) return answer;
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

  if (existsSync(configPath)) {
    process.stdout.write("\n");
    say(pc.yellow(`A config already exists at ${configPath}.`));
    say("");
    const overwrite = (await rl.question(`${pc.dim("Overwrite it? (y/N)")} `)).trim().toLowerCase();
    if (overwrite !== "y" && overwrite !== "yes") {
      rl.close();
      say(pc.dim(`\nKept the existing config. Run paperino --configure to edit it.`));
      return;
    }
    say("");
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
  say(pc.dim("This is templated into the prompt Claude uses to judge relevance —"));
  say(pc.dim("be specific: methods, problem, domain. A couple of sentences is enough."));
  say("");
  const researchInterests = await askRequired("Describe your research:");

  // ---- Step 2: arXiv categories ----
  heading(2, "Which arXiv categories should paperino fetch from?");
  say(pc.dim("One is enough to start. Comma-separated for more than one."));
  say(pc.dim("Full taxonomy: https://arxiv.org/category_taxonomy"));
  say("");
  for (const cat of COMMON_CATEGORIES) {
    say(`  ${cat.code.padEnd(8)} ${pc.dim(`(${cat.name})`)}`);
  }
  say("");
  const arxivCatRaw = await askRequired("Category codes (comma-separated):", validateCategories);
  const arxivCat = arxivCatRaw.split(",").map((s) => s.trim()).filter(Boolean);

  // ---- Step 3: output directory ----
  heading(3, "Where should the digests go?");
  say(pc.dim("Each run writes one file, <dir>/YYYY-MM-DD.html, so they sit side by side."));
  say(pc.dim("Pick somewhere you'll actually look. Must be an absolute path (~ is fine)."));
  say("");
  const outDir = await ask("Digest directory", "~/paperino/digests", validateOutDir);

  // ---- Step 4: models ----
  heading(4, "Models");
  say(pc.dim("Coarse pass screens every paper by title alone (cheap/fast model)."));
  say(pc.dim("Fine pass scores only what survives, reading title + abstract (stronger model)."));
  say("");
  const coarseModel = await askChoice("Coarse model", ALLOWED_MODELS, "haiku");
  const fineModel = await askChoice("Fine model", ALLOWED_MODELS, "sonnet");

  // ---- Step 5: batch size ----
  heading(5, "Batch size");
  say(pc.dim("How many papers go into a single Claude call — coarse reads titles only,"));
  say(pc.dim("fine reads title + abstract, so it uses smaller batches."));
  say("");
  const coarseCallSizeRaw = await ask(
    "Papers per coarse (titles) call",
    "20",
    positiveInteger("Papers per coarse call", { min: 1 }),
  );
  const fineCallSizeRaw = await ask(
    "Papers per fine (title+abstract) call",
    "5",
    positiveInteger("Papers per fine call", { min: 1 }),
  );
  const coarseCallSize = Number.parseInt(coarseCallSizeRaw, 10);
  const fineCallSize = Number.parseInt(fineCallSizeRaw, 10);

  // ---- Step 6: concurrency ----
  heading(6, "Concurrency");
  say(pc.dim("How many calls run at once, per stage. Higher is faster but uses more"));
  say(pc.dim("system resources on your machine."));
  say("");
  const maxWorkersRaw = await ask("Concurrent calls", "10", positiveInteger("Concurrent calls", { min: 1 }));
  const maxWorkers = Number.parseInt(maxWorkersRaw, 10);

  // ---- Confirmation before writing anything ----
  say(`\n${pc.bold("Ready to create your config")}`);
  say("");
  say(`${pc.dim("Research interests")}  ${researchInterests}`);
  say(`${pc.dim("arXiv categories")}    ${arxivCat.join(", ")}`);
  say(`${pc.dim("Digest directory")}    ${outDir}`);
  say(`${pc.dim("Coarse model")}        ${coarseModel} (${coarseCallSize} papers/call)`);
  say(`${pc.dim("Fine model")}          ${fineModel} (${fineCallSize} papers/call)`);
  say(`${pc.dim("Concurrency")}         ${maxWorkers} concurrent calls`);
  say("");
  say(pc.dim(`This will be written to ${configPath}`));
  say("");

  const confirm = (await rl.question(`${pc.dim("Press Enter to save (any other key to cancel)")} `)).trim();
  rl.close();

  if (confirm !== "") {
    say(pc.yellow("\nCancelled — no config was written."));
    return;
  }

  const templatePath = new URL("./bootstrap-config.toml", import.meta.url).pathname;
  const template = readFileSync(templatePath, "utf-8");
  let rendered = renderConfig(template, {
    researchInterests,
    arxivCat,
    outDir,
    coarseModel,
    fineModel,
    coarseCallSize,
    fineCallSize,
    maxWorkers,
  });

  const claudeBinary = detectClaudeBinary();
  if (claudeBinary) {
    rendered = rendered.replace('CLAUDE_BINARY = "claude"', `CLAUDE_BINARY = "${claudeBinary}"`);
  } else {
    process.stderr.write(
      "warning: claude CLI not found — set RUNTIME.CLAUDE_BINARY in the config once it's installed.\n",
    );
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, rendered, "utf-8");

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
  say(pc.dim("    run on the most recent submission window"));
  say("");
  say(`  ${pc.cyan("paperino --start-from 3")}`);
  say(pc.dim("    run on the window from 3 windows ago instead of the most recent"));
  say("");
  say(`  ${pc.cyan("paperino --start-from 3 --windows 3")}`);
  say(pc.dim("    catch up on the last 3 windows, oldest of which starts 3 windows back"));
  say("");
  say(`  ${pc.cyan("paperino --max-papers 50")}`);
  say(pc.dim("    cap each window at 50 papers (most recently submitted first)"));
  say("");
  say(`  ${pc.cyan("paperino --only-fetch")}`);
  say(pc.dim("    fetch papers without running the coarse/fine scoring pipeline"));
  say("");
  say(`  ${pc.cyan("paperino --logs")}`);
  say(pc.dim("    tail the log file — useful after a run reports failed calls"));
  say("");
  say(`  ${pc.cyan("paperino -y --quiet")}`);
  say(pc.dim("    skip the confirmation prompt and only print the digest path — what a cron job wants"));
}
