import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

[RESEARCH]
ARXIV_CAT = ["cs.CV"]
RESEARCH_INTERESTS = "point clouds"
MIN_SCORE = 6

[OUTPUT]
OUT_DIR = "~/.paperino/outputs"
LOG_FILE = "~/.paperino/paperino.log"

[STAGES.COARSE]
MODEL = "haiku"
CALL_SIZE = 20
MAX_WORKERS = 10
PROMPT = "prompt with {research_interests} and {papers}"

[STAGES.FINE]
MODEL = "sonnet"
CALL_SIZE = 5
MAX_WORKERS = 10
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
  });

  it("expands ~ in OUT_DIR", () => {
    writeFileSync(configPath, VALID_TOML, "utf-8");
    const config = loadConfig(configPath);

    expect(config.outDir).not.toContain("~");
    expect(config.outDir.endsWith("/.paperino/outputs")).toBe(true);
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
  it("does nothing if the config file already exists", () => {
    writeFileSync(configPath, "sentinel content", "utf-8");
    ensureConfig(configPath);
    expect(readFileSync(configPath, "utf-8")).toBe("sentinel content");
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
