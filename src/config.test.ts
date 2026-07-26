import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureConfig, loadConfig } from "./config.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paperino-config-test-"));
  configPath = join(dir, "config.toml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unmock("node:child_process");
});

const VALID_TOML = `
[RUNTIME]
CLAUDE_BINARY = "/usr/local/bin/claude"
CALL_TIMEOUT_SECONDS = 300
CALL_RETRIES = 1
MAX_WORKERS = 10

[RESEARCH]
ARXIV_CAT = ["cs.CV"]
RESEARCH_INTERESTS = "point clouds"
MIN_SCORE = 6

[OUTPUT]
OUT_DIR = "~/paperino/digests"
CACHE_DIR = "~/.paperino/cache"
LOG_FILE = "~/.paperino/paperino.log"

[STAGES.COARSE]
MODEL = "haiku"
CALL_SIZE = 20
PROMPT = "prompt with {research_interests} and {papers}"

[STAGES.FINE]
MODEL = "sonnet"
CALL_SIZE = 5
PROMPT = "prompt with {research_interests} and {papers}"
`;

describe("loadConfig", () => {
  it("maps UPPER_SNAKE_CASE keys to camelCase Config fields", () => {
    writeFileSync(configPath, VALID_TOML, "utf-8");
    const config = loadConfig(configPath);

    expect(config.claudeBinary).toBe("/usr/local/bin/claude");
    expect(config.arxivCat).toEqual(["cs.CV"]);
    expect(config.researchInterests).toBe("point clouds");
    expect(config.minScore).toBe(6);
    expect(config.callTimeoutMs).toBe(300_000);
    expect(config.callRetries).toBe(1);
    expect(config.coarse).toEqual({
      model: "haiku",
      callSize: 20,
      maxWorkers: 10,
      prompt: "prompt with {research_interests} and {papers}",
    });
    expect(config.fine).toEqual({
      model: "sonnet",
      callSize: 5,
      maxWorkers: 10,
      prompt: "prompt with {research_interests} and {papers}",
    });
    expect(config.email).toBeUndefined();
  });

  it("uses RUNTIME.MAX_WORKERS for both scoring stages", () => {
    writeFileSync(configPath, VALID_TOML.replace("MAX_WORKERS = 10", "MAX_WORKERS = 3"), "utf-8");
    const config = loadConfig(configPath);

    expect(config.coarse.maxWorkers).toBe(3);
    expect(config.fine.maxWorkers).toBe(3);
  });

  it("loads a config normalized by ensureConfig", () => {
    const legacy = VALID_TOML
      .replace('CALL_TIMEOUT_SECONDS = 300\n', "")
      .replace('MIN_SCORE = 6\n', "")
      .replace('CACHE_DIR = "~/.paperino/cache"\n', "")
      .replace('PROMPT = "prompt with {research_interests} and {papers}"\n\n[STAGES.FINE]', "[STAGES.FINE]")
      .replace('PROMPT = "prompt with {research_interests} and {papers}"\n', "");
    writeFileSync(configPath, legacy, "utf-8");
    ensureConfig(configPath);

    const config = loadConfig(configPath);

    expect(config.callTimeoutMs).toBe(300_000);
    expect(config.minScore).toBe(6);
    expect(config.cacheDir.endsWith("/.paperino/cache")).toBe(true);
    expect(config.coarse.prompt).toContain("{research_interests}");
    expect(config.fine.prompt).toContain("{papers}");
    expect(config.callRetries).toBe(1);
    expect(config.claudeBinary).toBe("/usr/local/bin/claude");
  });

  it("loads a missing table restored by ensureConfig", () => {
    writeFileSync(configPath, VALID_TOML.replace(/\n\[STAGES\.FINE\][\s\S]*$/, "\n"), "utf-8");
    ensureConfig(configPath);

    const config = loadConfig(configPath);

    expect(config.fine).toEqual({
      model: "sonnet",
      callSize: 5,
      maxWorkers: 10,
      prompt: expect.stringContaining("{research_interests}"),
    });
  });

  it("requires ensureConfig to populate missing values", () => {
    writeFileSync(configPath, VALID_TOML.replace('CACHE_DIR = "~/.paperino/cache"\n', ""), "utf-8");

    expect(() => loadConfig(configPath)).toThrow(/OUTPUT\.CACHE_DIR/);
  });

  it("preserves a migrated legacy max workers value", () => {
    const legacy = VALID_TOML
      .replace("MAX_WORKERS = 10\n", "")
      .replace('CALL_SIZE = 20\n', 'CALL_SIZE = 20\nMAX_WORKERS = 3\n');
    writeFileSync(configPath, legacy, "utf-8");
    ensureConfig(configPath);

    const config = loadConfig(configPath);
    const updated = readFileSync(configPath, "utf-8");

    expect(config.coarse.maxWorkers).toBe(3);
    expect(config.fine.maxWorkers).toBe(3);
    expect(updated).toContain("MAX_WORKERS = 3");
    expect(updated).not.toMatch(/\[STAGES\.COARSE\][\s\S]*MAX_WORKERS/);
  });

  it("loads optional Gmail email delivery settings", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace(
        "[STAGES.COARSE]",
        `[EMAIL]
SENDER_ADDRESS = "sender@gmail.com"
RECIPIENT_ADDRESS = "digest@example.com"
APP_PASSWORD = "abcdefghijklmnop"

[STAGES.COARSE]`,
      ),
      "utf-8",
    );

    expect(loadConfig(configPath).email).toEqual({
      senderAddress: "sender@gmail.com",
      recipientAddress: "digest@example.com",
      appPassword: "abcdefghijklmnop",
    });
  });

  it("rejects incomplete email delivery settings", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace(
        "[STAGES.COARSE]",
        `[EMAIL]
SENDER_ADDRESS = "sender@gmail.com"
RECIPIENT_ADDRESS = ""
APP_PASSWORD = "abcdefghijklmnop"

[STAGES.COARSE]`,
      ),
      "utf-8",
    );

    expect(() => loadConfig(configPath)).toThrow(/EMAIL\.RECIPIENT_ADDRESS.*empty/);
  });

  it("rejects malformed sender and recipient email addresses", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace(
        "[STAGES.COARSE]",
        `[EMAIL]
SENDER_ADDRESS = "not-an-email"
RECIPIENT_ADDRESS = "also-not-an-email"
APP_PASSWORD = "abcdefghijklmnop"

[STAGES.COARSE]`,
      ),
      "utf-8",
    );

    expect(() => loadConfig(configPath)).toThrow(/EMAIL\.SENDER_ADDRESS.*valid email address[\s\S]*EMAIL\.RECIPIENT_ADDRESS.*valid email address/);
  });

  it("expands ~ in OUT_DIR", () => {
    writeFileSync(configPath, VALID_TOML, "utf-8");
    const config = loadConfig(configPath);

    expect(config.outDir).not.toContain("~");
    expect(config.outDir.endsWith("/paperino/digests")).toBe(true);
  });

  it("expands ~ in CACHE_DIR", () => {
    writeFileSync(configPath, VALID_TOML, "utf-8");
    const config = loadConfig(configPath);

    expect(config.cacheDir).not.toContain("~");
    expect(config.cacheDir.endsWith("/.paperino/cache")).toBe(true);
  });

  it("rejects a relative OUT_DIR, which would depend on the launch directory", () => {
    writeFileSync(configPath, VALID_TOML.replace('OUT_DIR = "~/paperino/digests"', 'OUT_DIR = "digests"'), "utf-8");

    expect(() => loadConfig(configPath)).toThrow(/OUTPUT\.OUT_DIR.*absolute/s);
  });

  it("rejects an unwritable OUT_DIR at load time, before any model calls", () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      writeFileSync(
        configPath,
        VALID_TOML.replace('OUT_DIR = "~/paperino/digests"', `OUT_DIR = "${join(locked, "digests")}"`),
        "utf-8",
      );
      expect(() => loadConfig(configPath)).toThrow(/OUTPUT\.OUT_DIR" is not writable.*permission denied/s);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("rejects an OUT_DIR blocked by a file in the path", () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    writeFileSync(
      configPath,
      VALID_TOML.replace('OUT_DIR = "~/paperino/digests"', `OUT_DIR = "${join(blocker, "digests")}"`),
      "utf-8",
    );

    expect(() => loadConfig(configPath)).toThrow(/OUTPUT\.OUT_DIR" is not writable.*file is in the way/s);
  });

  it("rejects a relative CACHE_DIR", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace('CACHE_DIR = "~/.paperino/cache"', 'CACHE_DIR = "./cache"'),
      "utf-8",
    );

    expect(() => loadConfig(configPath)).toThrow(/OUTPUT\.CACHE_DIR.*absolute/s);
  });

  it("expands ~ in LOG_FILE", () => {
    writeFileSync(configPath, VALID_TOML, "utf-8");
    const config = loadConfig(configPath);

    expect(config.logFile).not.toContain("~");
    expect(config.logFile.endsWith("/.paperino/paperino.log")).toBe(true);
  });

  it("fails loudly when RESEARCH_INTERESTS is empty", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace('RESEARCH_INTERESTS = "point clouds"', 'RESEARCH_INTERESTS = ""'),
      "utf-8",
    );
    expect(() => loadConfig(configPath)).toThrow(/RESEARCH_INTERESTS/);
  });

  it("fails loudly when ARXIV_CAT is empty", () => {
    writeFileSync(configPath, VALID_TOML.replace('ARXIV_CAT = ["cs.CV"]', "ARXIV_CAT = []"), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/ARXIV_CAT/);
  });

  it("reports every invalid field in a single error instead of one at a time", () => {
    const broken = VALID_TOML.replace('ARXIV_CAT = ["cs.CV"]', "ARXIV_CAT = []").replace(
      'RESEARCH_INTERESTS = "point clouds"',
      'RESEARCH_INTERESTS = ""',
    );
    writeFileSync(configPath, broken, "utf-8");
    try {
      loadConfig(configPath);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/ARXIV_CAT/);
      expect((err as Error).message).toMatch(/RESEARCH_INTERESTS/);
    }
  });

  it("fails loudly when a stage MODEL isn't one of the allowed aliases", () => {
    writeFileSync(configPath, VALID_TOML.replace('MODEL = "haiku"', 'MODEL = "claude-haiku-4-5"'), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/STAGES\.COARSE\.MODEL.*must be one of/);
  });

  it("fails loudly when CALL_TIMEOUT_SECONDS isn't positive", () => {
    writeFileSync(configPath, VALID_TOML.replace("CALL_TIMEOUT_SECONDS = 300", "CALL_TIMEOUT_SECONDS = 0"), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/CALL_TIMEOUT_SECONDS/);
  });

  it("fails loudly when CALL_RETRIES is negative", () => {
    writeFileSync(configPath, VALID_TOML.replace("CALL_RETRIES = 1", "CALL_RETRIES = -1"), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/CALL_RETRIES/);
  });

  it("fails loudly when MIN_SCORE is outside 1-10", () => {
    writeFileSync(configPath, VALID_TOML.replace("MIN_SCORE = 6", "MIN_SCORE = 11"), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/MIN_SCORE/);
  });

  it("fails loudly when an ARXIV_CAT entry doesn't look like a category", () => {
    writeFileSync(configPath, VALID_TOML.replace('ARXIV_CAT = ["cs.CV"]', 'ARXIV_CAT = ["not_a_category!"]'), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/ARXIV_CAT/);
  });

  it("fails loudly when an ARXIV_CAT entry is a bare archive with no real subcategory (e.g. \"stat\")", () => {
    writeFileSync(configPath, VALID_TOML.replace('ARXIV_CAT = ["cs.CV"]', 'ARXIV_CAT = ["stat"]'), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/ARXIV_CAT/);
  });

  it("accepts a bare category code that is itself a real leaf taxonomy entry (e.g. \"quant-ph\")", () => {
    writeFileSync(configPath, VALID_TOML.replace('ARXIV_CAT = ["cs.CV"]', 'ARXIV_CAT = ["quant-ph"]'), "utf-8");
    const config = loadConfig(configPath);
    expect(config.arxivCat).toEqual(["quant-ph"]);
  });

  it("fails loudly when a stage PROMPT is missing a placeholder", () => {
    writeFileSync(
      configPath,
      VALID_TOML.replace(
        'PROMPT = "prompt with {research_interests} and {papers}"\n\n[STAGES.FINE]',
        'PROMPT = "prompt with {research_interests} only"\n\n[STAGES.FINE]',
      ),
      "utf-8",
    );
    expect(() => loadConfig(configPath)).toThrow(/STAGES\.COARSE\.PROMPT.*\{papers\}/);
  });

  it("fails loudly when a stage CALL_SIZE isn't positive", () => {
    writeFileSync(configPath, VALID_TOML.replace("CALL_SIZE = 20", "CALL_SIZE = 0"), "utf-8");
    expect(() => loadConfig(configPath)).toThrow(/STAGES\.COARSE\.CALL_SIZE/);
  });

});

describe("ensureConfig", () => {
  it("does not rewrite an already complete config", () => {
    const complete = VALID_TOML.replace(
      "[STAGES.COARSE]",
      `[EMAIL]
SENDER_ADDRESS = ""
RECIPIENT_ADDRESS = ""
APP_PASSWORD = ""

[STAGES.COARSE]`,
    );
    writeFileSync(configPath, complete, "utf-8");
    ensureConfig(configPath);
    expect(readFileSync(configPath, "utf-8")).toBe(complete);
  });

  it("writes missing values from the bootstrap config", () => {
    writeFileSync(configPath, VALID_TOML.replace('CACHE_DIR = "~/.paperino/cache"\n', ""), "utf-8");

    ensureConfig(configPath);

    expect(readFileSync(configPath, "utf-8")).toContain('CACHE_DIR = "~/.paperino/cache"');
  });

  it("templates CLAUDE_BINARY from `which claude` when detection succeeds", async () => {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => "/opt/homebrew/bin/claude\n"),
      };
    });
    vi.resetModules();
    const { ensureConfig: ensureConfigMocked } = await import("./config.js");

    ensureConfigMocked(configPath);

    const written = readFileSync(configPath, "utf-8");
    expect(written).toContain('CLAUDE_BINARY = "/opt/homebrew/bin/claude"');
  });

  it("falls back to the \"claude\" placeholder and warns on stderr when detection fails", async () => {
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          throw new Error("not found");
        }),
      };
    });
    vi.resetModules();
    const { ensureConfig: ensureConfigMocked } = await import("./config.js");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    ensureConfigMocked(configPath);

    const written = readFileSync(configPath, "utf-8");
    expect(written).toContain('CLAUDE_BINARY = "claude"');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("claude CLI not found"));
  });
});
