import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchRecentPapers } from "./fetch.js";

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>3</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>100</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>
      A Single Category Paper
    </title>
    <summary>
      This is the abstract of the single-category paper.
    </summary>
    <published>2026-01-05T14:00:00Z</published>
    <link href="http://arxiv.org/abs/2601.00001v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2601.00001v1" rel="related" type="application/pdf"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:comment>10 pages, 5 figures</arxiv:comment>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00002v2</id>
    <title>A Two Category Paper</title>
    <summary>Abstract of the two-category paper.</summary>
    <published>2026-01-05T13:00:00Z</published>
    <link href="http://arxiv.org/abs/2601.00002v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2601.00002v2" rel="related" type="application/pdf"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:journal_ref>Journal of Examples, 2026</arxiv:journal_ref>
    <arxiv:comment>Accepted at ICML</arxiv:comment>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00003v1</id>
    <title>A Three Category Paper</title>
    <summary>Abstract of the three-category paper.</summary>
    <published>2026-01-05T12:00:00Z</published>
    <link href="http://arxiv.org/abs/2601.00003v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2601.00003v1" rel="related" type="application/pdf"/>
    <category term="cs.RO" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const EMPTY_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>100</opensearch:itemsPerPage>
</feed>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRecentPapers", () => {
  it("parses single/2/3-category entries with and without journal_ref", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => SAMPLE_FEED,
    });
    vi.stubGlobal("fetch", fetchMock);

    const papers = await fetchRecentPapers(["cs.CV"], new Date(0), new Date(1), undefined);

    expect(papers).toHaveLength(3);

    expect(papers[0]).toEqual({
      id: "2601.00001v1",
      title: "A Single Category Paper",
      abstract: "This is the abstract of the single-category paper.",
      link: "http://arxiv.org/abs/2601.00001v1",
      categories: ["cs.CV"],
      published: "2026-01-05T14:00:00Z",
      journalRef: null,
      comment: "10 pages, 5 figures",
    });

    expect(papers[1]).toEqual({
      id: "2601.00002v2",
      title: "A Two Category Paper",
      abstract: "Abstract of the two-category paper.",
      link: "http://arxiv.org/abs/2601.00002v2",
      categories: ["cs.LG", "cs.CV"],
      published: "2026-01-05T13:00:00Z",
      journalRef: "Journal of Examples, 2026",
      comment: "Accepted at ICML",
    });

    expect(papers[2]).toEqual({
      id: "2601.00003v1",
      title: "A Three Category Paper",
      abstract: "Abstract of the three-category paper.",
      link: "http://arxiv.org/abs/2601.00003v1",
      categories: ["cs.RO", "cs.CV", "cs.AI"],
      published: "2026-01-05T12:00:00Z",
      journalRef: null,
      comment: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => EMPTY_FEED,
      }),
    );

    const papers = await fetchRecentPapers(["cs.CV"], new Date(0), new Date(1), undefined);
    expect(papers).toEqual([]);
  });

  it("caps results at maxPapers, most-recent-first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => SAMPLE_FEED,
      }),
    );

    const papers = await fetchRecentPapers(["cs.CV"], new Date(0), new Date(1), 2);
    expect(papers).toHaveLength(2);
    expect(papers.map((p) => p.id)).toEqual(["2601.00001v1", "2601.00002v2"]);
  });
});
