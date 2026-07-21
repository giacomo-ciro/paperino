import { XMLParser } from "fast-xml-parser";
import type { Paper } from "./types.js";

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const PAGE_SIZE = 100;
const INTER_PAGE_DELAY_MS = 3000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "category", "author", "link"].includes(name),
  removeNSPrefix: true,
});

interface AtomLink {
  "@_href": string;
  "@_rel"?: string;
}

interface AtomCategory {
  "@_term": string;
}

interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  link: AtomLink[];
  category: AtomCategory[];
  journal_ref?: string;
  comment?: string;
}

interface AtomFeed {
  feed: {
    totalResults: number;
    entry?: AtomEntry[];
  };
}

function toPaper(entry: AtomEntry): Paper {
  const id = entry.id.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replaceAll("/", "_");
  const link = entry.link.find((l) => l["@_rel"] === "alternate")?.["@_href"] ?? entry.id;

  return {
    id,
    title: entry.title.trim(),
    abstract: entry.summary.trim(),
    link,
    categories: entry.category.map((c) => c["@_term"]),
    published: entry.published,
    journalRef: entry.journal_ref ?? null,
    comment: entry.comment ?? null,
  };
}

function formatArxivDate(d: Date): string {
  // YYYYMMDDHHmm, UTC (arXiv's submittedDate filter is GMT)
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch every arXiv paper in `categories` submitted within [start, end] UTC.
 * If `maxPapers` is set, only the most recently submitted N are returned.
 */
export async function fetchRecentPapers(
  categories: string[],
  start: Date,
  end: Date,
  maxPapers?: number,
): Promise<Paper[]> {
  const dateFilter = `submittedDate:[${formatArxivDate(start)} TO ${formatArxivDate(end)}]`;
  const catFilter = categories.map((c) => `cat:${c}`).join(" OR ");
  const searchQuery = `(${catFilter}) AND ${dateFilter}`;

  const papers: Paper[] = [];
  let start_ = 0;
  let totalResults = Infinity;

  while (start_ < totalResults && (maxPapers === undefined || papers.length < maxPapers)) {
    if (start_ > 0) {
      await sleep(INTER_PAGE_DELAY_MS);
    }

    const url = new URL(ARXIV_API_BASE);
    url.searchParams.set("search_query", searchQuery);
    url.searchParams.set("start", String(start_));
    url.searchParams.set("max_results", String(PAGE_SIZE));
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`arXiv API request failed: ${response.status} ${response.statusText}`);
    }
    const xml = await response.text();
    const parsed = parser.parse(xml) as AtomFeed;

    totalResults = parsed.feed.totalResults;
    const entries = parsed.feed.entry ?? [];
    if (entries.length === 0) {
      break;
    }

    for (const entry of entries) {
      papers.push(toPaper(entry));
      if (maxPapers !== undefined && papers.length >= maxPapers) {
        break;
      }
    }

    start_ += entries.length;
  }

  return maxPapers !== undefined ? papers.slice(0, maxPapers) : papers;
}
