import { describe, expect, it } from "vitest";
import { coarseFilter, fineScoring, type ScoringProgress } from "./scoring.js";
import type { Agent, AgentResult, Config, Paper } from "./types.js";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    abstract: `Abstract ${id}`,
    link: `https://arxiv.org/abs/${id}`,
    categories: ["cs.CV"],
    published: "2026-01-05T14:00:00Z",
    journalRef: null,
    comment: null,
    ...overrides,
  };
}

const baseConfig: Config = {
  claudeBinary: "claude",
  arxivCat: ["cs.CV"],
  researchInterests: "test interests",
  minScore: 6,
  outDir: "/tmp/out",
  logFile: "/tmp/out/paperino.log",
  callTimeoutMs: 1000,
  callRetries: 1,
  coarse: {
    model: "haiku",
    callSize: 20,
    maxWorkers: 4,
    prompt: "interests: {research_interests}\npapers: {papers}",
  },
  fine: {
    model: "sonnet",
    callSize: 5,
    maxWorkers: 4,
    prompt: "interests: {research_interests}\npapers: {papers}",
  },
};

function mockAgent(run: (prompt: string) => Promise<AgentResult>): Agent {
  return { name: "mock", run };
}

describe("coarseFilter", () => {
  it("marks coarse from a valid verdicts array", async () => {
    const papers = [paper("a"), paper("b")];
    const agent = mockAgent(async () => ({
      output: { verdicts: [{ id: "a", coarse: 1 }, { id: "b", coarse: 0 }] },
    }));

    await coarseFilter(papers, baseConfig, agent);

    expect(papers[0].coarse).toBe(1);
    expect(papers[1].coarse).toBe(0);
  });

  it("fails open: keeps all papers when the call errors", async () => {
    const papers = [paper("a"), paper("b")];
    const agent = mockAgent(async () => {
      throw new Error("boom");
    });

    await coarseFilter(papers, baseConfig, agent);

    expect(papers[0].coarse).toBe(1);
    expect(papers[1].coarse).toBe(1);
  });

  it("fails open: keeps a paper with a missing verdict", async () => {
    const papers = [paper("a"), paper("b")];
    const agent = mockAgent(async () => ({ output: { verdicts: [{ id: "a", coarse: 0 }] } })); // b missing

    await coarseFilter(papers, baseConfig, agent);

    expect(papers[0].coarse).toBe(0);
    expect(papers[1].coarse).toBe(1); // missing verdict -> keep
  });

  it("skips papers that already have coarse set", async () => {
    const papers = [paper("a", { coarse: 0 })];
    let called = false;
    const agent = mockAgent(async () => {
      called = true;
      return { output: { verdicts: [{ id: "a", coarse: 1 }] } };
    });

    await coarseFilter(papers, baseConfig, agent);

    expect(called).toBe(false);
    expect(papers[0].coarse).toBe(0);
  });

  it("reports a failed call via onProgress and onCallFailed", async () => {
    const papers = [paper("a"), paper("b")];
    const agent = mockAgent(async () => {
      throw new Error("boom");
    });

    let lastProgress: ScoringProgress | undefined;
    const failures: string[] = [];

    await coarseFilter(
      papers,
      baseConfig,
      agent,
      (p) => {
        lastProgress = p;
      },
      (err) => failures.push(err),
    );

    expect(lastProgress?.failed).toBe(1);
    // callRetries: 1 -> one retry attempt fails (logged), then the final attempt's error is reported.
    expect(failures).toEqual(["attempt 1/2 failed, retrying — boom", "boom"]);
  });

  it("reports a malformed (non-object) verdict shape as a failed call", async () => {
    const papers = [paper("a")];
    const agent = mockAgent(async () => ({ output: [1, 2, 3] }));

    let lastProgress: ScoringProgress | undefined;
    const failures: string[] = [];

    await coarseFilter(
      papers,
      baseConfig,
      agent,
      (p) => {
        lastProgress = p;
      },
      (err) => failures.push(err),
    );

    expect(lastProgress?.failed).toBe(1);
    expect(failures).toEqual(["malformed output shape"]);
  });

  it("does not count a call that succeeds after a retry as failed", async () => {
    const papers = [paper("a")];
    let attempts = 0;
    const agent = mockAgent(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return { output: { verdicts: [{ id: "a", coarse: 1 }] } };
    });

    let lastProgress: ScoringProgress | undefined;
    const failures: string[] = [];

    await coarseFilter(
      papers,
      baseConfig,
      agent,
      (p) => {
        lastProgress = p;
      },
      (err) => failures.push(err),
    );

    expect(lastProgress?.failed).toBe(0);
    expect(failures).toEqual(["attempt 1/2 failed, retrying — transient"]);
  });
});

describe("fineScoring", () => {
  it("maps snake_case entries to camelCase Paper fields", async () => {
    const papers = [paper("a", { coarse: 1 })];
    const agent = mockAgent(async () => ({
      output: {
        papers: [
          {
            id: "a",
            score: 8,
            summary: "sum",
            key_contribution: "kc",
            why_it_matters: "wim",
          },
        ],
      },
    }));

    await fineScoring(papers, baseConfig, agent);

    expect(papers[0].score).toBe(8);
    expect(papers[0].summary).toBe("sum");
    expect(papers[0].keyContribution).toBe("kc");
    expect(papers[0].whyItMatters).toBe("wim");
  });

  it("skip-on-fail: leaves papers unscored when the call errors", async () => {
    const papers = [paper("a", { coarse: 1 })];
    const agent = mockAgent(async () => {
      throw new Error("boom");
    });

    await fineScoring(papers, baseConfig, agent);

    expect(papers[0].score).toBeUndefined();
  });

  it("skip-on-fail: leaves a paper unscored on a garbled score", async () => {
    const papers = [paper("a", { coarse: 1 })];
    const agent = mockAgent(async () => ({
      output: { papers: [{ id: "a", score: "not-a-number", summary: "", key_contribution: "", why_it_matters: "" }] },
    }));

    await fineScoring(papers, baseConfig, agent);

    expect(papers[0].score).toBeUndefined();
  });

  it("only scores papers with coarse==1 and no existing score", async () => {
    const papers = [paper("a", { coarse: 0 }), paper("b", { coarse: 1, score: 5 }), paper("c", { coarse: 1 })];
    let promptedIds: string[] = [];
    const agent = mockAgent(async (prompt: string) => {
      promptedIds.push(prompt);
      return { output: { papers: [{ id: "c", score: 7, summary: "", key_contribution: "", why_it_matters: "" }] } };
    });

    await fineScoring(papers, baseConfig, agent);

    expect(promptedIds).toHaveLength(1);
    expect(promptedIds[0]).toContain("c");
    expect(promptedIds[0]).not.toContain("id: a");
    expect(papers[2].score).toBe(7);
    expect(papers[1].score).toBe(5); // untouched
  });

  it("reports a failed call via onProgress and onCallFailed", async () => {
    const papers = [paper("a", { coarse: 1 })];
    const agent = mockAgent(async () => {
      throw new Error("boom");
    });

    let lastProgress: ScoringProgress | undefined;
    const failures: string[] = [];

    await fineScoring(
      papers,
      baseConfig,
      agent,
      (p) => {
        lastProgress = p;
      },
      (err) => failures.push(err),
    );

    expect(lastProgress?.failed).toBe(1);
    expect(failures).toEqual(["attempt 1/2 failed, retrying — boom", "boom"]);
  });

  it("reports a malformed output shape (missing papers array) as a failed call", async () => {
    const papers = [paper("a", { coarse: 1 })];
    const agent = mockAgent(async () => ({ output: { notPapers: [] } }));

    let lastProgress: ScoringProgress | undefined;
    const failures: string[] = [];

    await fineScoring(
      papers,
      baseConfig,
      agent,
      (p) => {
        lastProgress = p;
      },
      (err) => failures.push(err),
    );

    expect(lastProgress?.failed).toBe(1);
    expect(failures).toEqual(["malformed output shape"]);
  });
});
