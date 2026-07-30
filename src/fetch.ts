import { XMLParser } from "fast-xml-parser";
import type { Author, Paper } from "./types.js";

const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const PAGE_SIZE = 100;
const INTER_PAGE_DELAY_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["entry", "category", "author", "link"].includes(name),
  removeNSPrefix: true,
  // Keep every text node a string: by default numeric-looking content is coerced
  // to a number, so a paper titled "1984" would crash .trim(). totalResults is
  // parsed back to a number explicitly below.
  parseTagValue: false,
});

interface AtomLink {
  "@_href": string;
  "@_rel"?: string;
}

interface AtomCategory {
  "@_term": string;
}

interface AtomAuthor {
  name: string;
  affiliation?: string | string[];
}

interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  link: AtomLink[];
  author?: AtomAuthor[];
  category: AtomCategory[];
  journal_ref?: string;
  comment?: string;
}

interface AtomFeed {
  feed: {
    totalResults: string; // parseTagValue:false keeps this a string
    entry?: AtomEntry[];
  };
}

function toAuthor(a: AtomAuthor): Author {
  const affiliations = (Array.isArray(a.affiliation) ? a.affiliation : [a.affiliation])
    .filter((affiliation): affiliation is string => typeof affiliation === "string")
    .map((affiliation) => affiliation.trim())
    .filter((affiliation) => affiliation !== "");
  return {
    name: a.name.trim(),
    affiliation: affiliations.length === 0 ? null : affiliations.join("; "),
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
    authors: (entry.author ?? []).map(toAuthor),
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

export type FetchDiagnostic = (message: string) => void;

function errorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch one page, retrying transport errors and transient HTTP statuses.
 * Throws the underlying technical error; the caller turns it into user-facing copy.
 */
async function fetchPage(url: URL, pageStart: number, diagnostic?: FetchDiagnostic): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    diagnostic?.(`arXiv page start=${pageStart}: request attempt ${attempt}/${MAX_ATTEMPTS}`);

    let response: Response | undefined;
    let xml: string | undefined;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        xml = await response.text();
      }
    } catch (error) {
      // Covers both connection failures and a body that dies mid-read; both are retryable.
      lastError = error;
      response = undefined;
    }

    if (xml !== undefined) {
      diagnostic?.(`arXiv page start=${pageStart}: received ${xml.length} bytes`);
      return xml;
    }

    if (response) {
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!isRetryableStatus(response.status)) {
        diagnostic?.(`arXiv page start=${pageStart}: request failed: ${errorDetail(lastError)}`);
        throw lastError;
      }
    }

    const detail = errorDetail(lastError);
    if (attempt === MAX_ATTEMPTS) {
      diagnostic?.(`arXiv page start=${pageStart}: request failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
      throw lastError;
    }

    diagnostic?.(`arXiv page start=${pageStart}: request failed (${detail}); retrying in ${INTER_PAGE_DELAY_MS / 1000}s`);
    await sleep(INTER_PAGE_DELAY_MS);
  }

  // The loop always either returns or throws; this keeps TypeScript's control flow explicit.
  throw lastError;
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
  diagnostic?: FetchDiagnostic,
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

    const xml = await fetchPage(url, start_, diagnostic);
    const parsed = parser.parse(xml) as AtomFeed;

    totalResults = Number(parsed.feed.totalResults);
    const entries = parsed.feed.entry ?? [];
    diagnostic?.(`arXiv page start=${start_}: ${entries.length} papers returned (${totalResults} total)`);
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
