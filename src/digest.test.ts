import { describe, expect, it } from "vitest";
import { buildDigest, escapeHtml } from "./digest.js";
import type { Paper } from "./types.js";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    abstract: "abstract",
    link: `https://arxiv.org/abs/${id}`,
    categories: ["cs.CV"],
    published: "2026-01-05T14:00:00Z",
    journalRef: null,
    comment: null,
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the five reserved characters", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });
});

describe("buildDigest", () => {
  it("returns the empty-state body when there are no coarse-passed papers", () => {
    const { subject, body } = buildDigest([paper("a", { coarse: 0 })], "2026-01-05", 6);
    expect(subject).toBe("arXiv digest — 2026-01-05 (0 papers)");
    expect(body).toContain("submission window 2026-01-05 — no relevant papers.");
    expect(body).toContain("built by");
  });

  it("splits into full cards (>= minScore) vs one-line items (< minScore)", () => {
    const papers = [
      paper("high", { coarse: 1, score: 9, summary: "s", keyContribution: "k", whyItMatters: "w" }),
      paper("low", { coarse: 1, score: 3 }),
      paper("unscored", { coarse: 1 }), // no score at all
      paper("dropped", { coarse: 0 }), // filtered out entirely
    ];

    const { subject, body } = buildDigest(papers, "2026-01-05", 6);

    expect(subject).toBe("arXiv digest — 2026-01-05 (1 papers)");
    expect(body).toContain("Title high");
    expect(body).toContain("Score: 9/10");
    expect(body).toContain("Lower-scored papers");
    expect(body).toContain("Title low");
    expect(body).toContain("(score 3)");
    expect(body).toContain("Title unscored");
    expect(body).toContain("(unscored)");
    expect(body).not.toContain("Title dropped");
  });

  it("sorts kept papers by score descending", () => {
    const papers = [
      paper("mid", { coarse: 1, score: 7 }),
      paper("top", { coarse: 1, score: 10 }),
    ];
    const { body } = buildDigest(papers, "2026-01-05", 6);
    expect(body.indexOf("Title top")).toBeLessThan(body.indexOf("Title mid"));
  });

  it("HTML-escapes title/summary/etc in a full card", () => {
    const papers = [
      paper("x", {
        coarse: 1,
        score: 9,
        title: "<script>alert(1)</script>",
        summary: "a & b",
      }),
    ];
    const { body } = buildDigest(papers, "2026-01-05", 6);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("a &amp; b");
  });
});
