import { describe, expect, it } from "vitest";
import { buildDigest, escapeHtml } from "./digest.js";
import type { Paper } from "./types.js";

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return {
    id,
    title: `Title ${id}`,
    abstract: "abstract",
    link: `https://arxiv.org/abs/${id}`,
    authors: [],
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

const WINDOW_END = new Date("2026-01-05T19:00:00Z"); // Monday

describe("buildDigest", () => {
  it("returns the empty-state body when there are no coarse-passed papers", () => {
    const { subject, body } = buildDigest([paper("a", { coarse: 0 })], WINDOW_END, 6);
    expect(subject).toBe("Paperino (Monday, 5 January 2026)");
    expect(body).toContain("<h1");
    expect(body).toContain("Paperino (Monday, 5 January 2026)");
    expect(body).toContain("No relevant papers.");
    expect(body).toContain("built by");
  });

  it("splits into full cards (>= minScore) vs one-line items (< minScore)", () => {
    const papers = [
      paper("high", { coarse: 1, score: 9, summary: "s", keyContribution: "k", whyItMatters: "w" }),
      paper("low", { coarse: 1, score: 3 }),
      paper("unscored", { coarse: 1 }), // no score at all
      paper("dropped", { coarse: 0 }), // filtered out entirely
    ];

    const { subject, body } = buildDigest(papers, WINDOW_END, 6);

    expect(subject).toBe("Paperino (Monday, 5 January 2026)");
    expect(body).toContain("3/4 papers passed the coarse filter, 1 scored ≥ 6.");
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
    const { body } = buildDigest(papers, WINDOW_END, 6);
    expect(body.indexOf("Title top")).toBeLessThan(body.indexOf("Title mid"));
  });

  it("renders every author, numbering deduped affiliations by first appearance", () => {
    const papers = [
      paper("x", {
        coarse: 1,
        score: 9,
        authors: [
          { name: "Ada Lovelace", affiliation: "Udine" },
          { name: "Alan Turing", affiliation: "ANDRA" },
          { name: "Grace Hopper", affiliation: "Udine" },
          { name: "Katherine Johnson", affiliation: null },
        ],
      }),
    ];
    const { body } = buildDigest(papers, WINDOW_END, 6);

    expect(body).toContain(
      "Ada Lovelace<sup>1</sup>, Alan Turing<sup>2</sup>, " +
        "Grace Hopper<sup>1</sup>, Katherine Johnson",
    );
    expect(body).toContain("<div><sup>1</sup>Udine</div><div><sup>2</sup>ANDRA</div>");
  });

  it("renders names only when no author has an affiliation", () => {
    const papers = [
      paper("x", {
        coarse: 1,
        score: 9,
        authors: [
          { name: "Ada Lovelace", affiliation: null },
          { name: "Alan Turing", affiliation: null },
        ],
      }),
    ];
    const { body } = buildDigest(papers, WINDOW_END, 6);

    expect(body).toContain("Ada Lovelace, Alan Turing");
    expect(body).not.toContain("<sup>");
  });

  it("omits the author block entirely when there are no authors", () => {
    const { body } = buildDigest([paper("x", { coarse: 1, score: 9 })], WINDOW_END, 6);
    expect(body).not.toContain("<sup>");
    expect(body).not.toContain("color:#555;margin:2px 0 2px");
  });

  it("HTML-escapes author names and affiliations", () => {
    const papers = [
      paper("x", {
        coarse: 1,
        score: 9,
        authors: [{ name: "<script>alert(1)</script>", affiliation: "Foo & Bar" }],
      }),
    ];
    const { body } = buildDigest(papers, WINDOW_END, 6);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("Foo &amp; Bar");
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
    const { body } = buildDigest(papers, WINDOW_END, 6);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("a &amp; b");
  });
});
