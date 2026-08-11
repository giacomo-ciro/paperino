import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { emailSettingsChanged, patchConfigureAnswers } from "./configure.js";

const templatePath = new URL("./bootstrap-config.toml", import.meta.url);

describe("patchConfigureAnswers", () => {
  it("changes only wizard fields, preserving comments and custom settings", () => {
    const source = readFileSync(templatePath, "utf-8")
      .replace("ARXIV_CAT = []", "ARXIV_CAT = [] # categories chosen for this project")
      .replace("MIN_SCORE = 6", "MIN_SCORE = 9 # keep this threshold")
      .replace("CALL_SIZE = 20 # papers per agent call", "CALL_SIZE = 20 # papers per agent call\nMAX_WORKERS = 2 # legacy")
      .replace("CALL_SIZE = 5 # papers per agent call", "CALL_SIZE = 5 # papers per agent call\nMAX_WORKERS = 3 # legacy")
      .replace('CACHE_DIR = "~/.paperino/cache"', 'CACHE_DIR = "/tmp/paperino-cache"')
      .replace("CALL_RETRIES = 1", "CALL_RETRIES = 3")
      .replace(
        "You are screening newly announced arXiv papers for relevance to a research project.",
        "Custom coarse prompt: {research_interests} {papers}",
      );

    const patched = patchConfigureAnswers(source, {
      agent: "codex",
      researchInterests: "point-cloud reconstruction",
      arxivCat: ["cs.CV"],
      outDir: "/tmp/digests",
      coarseModel: "haiku",
      fineModel: "sonnet",
      coarseCallSize: 30,
      fineCallSize: 6,
      maxWorkers: 4,
      senderAddress: "",
      recipientAddress: "",
      appPassword: "",
    });
    const config = parse(patched) as Record<string, unknown>;
    const research = config.RESEARCH as Record<string, unknown>;
    const output = config.OUTPUT as Record<string, unknown>;
    const runtime = config.RUNTIME as Record<string, unknown>;
    const stages = config.STAGES as Record<string, Record<string, unknown>>;

    expect(research).toMatchObject({
      ARXIV_CAT: ["cs.CV"],
      RESEARCH_INTERESTS: "point-cloud reconstruction",
      MIN_SCORE: 9,
    });
    expect(output).toMatchObject({ OUT_DIR: "/tmp/digests", CACHE_DIR: "/tmp/paperino-cache" });
    expect(runtime.CALL_RETRIES).toBe(3);
    expect(runtime.AGENT).toBe("codex");
    expect(stages.COARSE).toMatchObject({ CALL_SIZE: 30 });
    expect(stages.COARSE.PROMPT).toContain("Custom coarse prompt: {research_interests} {papers}");
    expect(stages.FINE).toMatchObject({ CALL_SIZE: 6 });
    expect((config.RUNTIME as Record<string, unknown>).MAX_WORKERS).toBe(4);
    expect(patched).not.toContain("# legacy");
    expect(patched).toContain("MIN_SCORE = 9 # keep this threshold");
    expect(patched).toMatch(/ARXIV_CAT = \[\s*"cs\.CV"\s*\] # categories chosen for this project/);
    expect(patched).toContain('CACHE_DIR = "/tmp/paperino-cache"');
    expect(patched).toContain("Custom coarse prompt: {research_interests} {papers}");
  });
});

describe("emailSettingsChanged", () => {
  const configured = {
    senderAddress: "sender@gmail.com",
    recipientAddress: "digest@example.com",
    appPassword: "abcdefghijklmnop",
  };

  it("does not require another test email when email settings are unchanged", () => {
    expect(emailSettingsChanged(configured, configured)).toBe(false);
  });

  it("requires a test email when an email setting changes", () => {
    expect(emailSettingsChanged(configured, { ...configured, recipientAddress: "other@example.com" })).toBe(true);
  });
});
