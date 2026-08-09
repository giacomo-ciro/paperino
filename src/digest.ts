import type { Author, Paper } from "./types.js";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** "Monday, 20 July 2026" on arXiv's US Eastern calendar. */
function formatAnnouncementDate(announcedAt: Date): string {
  return announcedAt.toLocaleDateString("en-GB", {
    timeZone: "America/New_York",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Build (subject, html body) from all papers that passed the coarse filter.
 * Papers scoring >= minScore get a full card; the rest (including papers left
 * unscored by a failed call) get a one-line mention at the bottom.
 *
 * `announcedAt` is the scheduled arXiv announcement time.
 */
export function buildDigest(
  papers: Paper[],
  announcedAt: Date,
  minScore: number,
): { subject: string; body: string; coarsePassed: number; scoredAboveMin: number } {
  const kept = papers
    .filter((p) => p.coarse === 1)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = kept.filter((p) => (p.score ?? 0) >= minScore);
  const rest = kept.filter((p) => (p.score ?? 0) < minScore);

  const subject = `Paperino (${formatAnnouncementDate(announcedAt)})`;
  const heading = `<h1 style="margin-bottom:4px">${escapeHtml(subject)}</h1>`;

  const counts = { coarsePassed: kept.length, scoredAboveMin: top.length };

  if (kept.length === 0) {
    return { subject, body: wrap(`${heading}\n<p style="margin-top:0">No relevant papers.</p>`), ...counts };
  }

  const parts = [
    heading,
    `<p style="margin-top:0">${kept.length}/${papers.length} papers passed the coarse filter, ${top.length} scored ≥ ${minScore}.</p>`,
  ];
  for (const p of top) {
    parts.push(card(p));
  }
  if (rest.length > 0) {
    const items = rest.map((p) => lineItem(p)).join("");
    parts.push(`<h3>Lower-scored papers</h3><ul>${items}</ul>`);
  }

  return { subject, body: wrap(parts.join("\n")), ...counts };
}

const HEART_SVG =
  `<svg width="12" height="12" viewBox="0 0 512 512" fill="currentColor" style="vertical-align:-1px" aria-hidden="true"><path d="M462.3 62.6C407.5 15.9 326 24.3 275.7 76.2L256 96.5l-19.7-20.3C186.1 24.3 104.5 15.9 49.7 62.6c-62.8 53.6-66.1 149.8-9.9 207.9l193.5 199.8c12.5 12.9 32.8 12.9 45.3 0l193.5-199.8c56.3-58.1 53-154.3-9.8-207.9z"/></svg>`;

function wrap(inner: string): string {
  return `<div style="max-width:900px;margin:0 auto;font-family:'Lucida Grande','Helvetica Neue',Helvetica,Arial,sans-serif;">

${inner}

<hr style="margin-top:32px;border:none;border-top:1px solid #ddd;">
<p style="color:#888;font-size:90%;text-align:center"><a href="https://github.com/giacomo-ciro/paperino" style="color:inherit" target="_blank">paperino</a> - built by <a href="https://giacomociro.com" style="color:inherit" target="_blank">giacomo-ciro</a>, with ${HEART_SVG}</p>
</div>`;
}

/**
 * Author list with numbered affiliation markers, followed by one line per
 * distinct affiliation (deduped, numbered by first appearance). Affiliations are
 * submitter-supplied and absent on most papers, in which case only the names render.
 */
function authorBlock(authors: Author[]): string {
  if (authors.length === 0) {
    return "";
  }

  const affiliations: string[] = [];
  for (const a of authors) {
    if (a.affiliation !== null && !affiliations.includes(a.affiliation)) {
      affiliations.push(a.affiliation);
    }
  }

  const names = authors
    .map((a) => {
      const marker =
        a.affiliation === null ? "" : `<sup>${affiliations.indexOf(a.affiliation) + 1}</sup>`;
      return `${escapeHtml(a.name)}${marker}`;
    })
    .join(", ");

  let out = `<p style="color:#555;margin:2px 0 2px">${names}</p>`;
  if (affiliations.length > 0) {
    const lines = affiliations
      .map((aff, i) => `<div><sup>${i + 1}</sup>${escapeHtml(aff)}</div>`)
      .join("");
    out += `<div style="color:#888;font-size:90%;margin:0 0 8px">${lines}</div>`;
  }
  return out;
}

function card(p: Paper): string {
  return `
<div style="margin-bottom:28px">
  <h3 style="margin-bottom:4px"><a href="${p.link}">${escapeHtml(p.title)}</a></h3>
  ${authorBlock(p.authors)}
  <p><b>Score: ${p.score}/10</b> — ${escapeHtml(p.summary ?? "")}</p>
  <p><b>Key contribution:</b> ${escapeHtml(p.keyContribution ?? "")}</p>
  <p><b>Why it matters:</b> ${escapeHtml(p.whyItMatters ?? "")}</p>
  <p><b>Journal/Conference:</b> ${escapeHtml(p.journalRef ?? "n/a")}</p>
  <p><b>Comment:</b> ${escapeHtml(p.comment ?? "n/a")}</p>
  <p style="color:#555;font-size:90%">${escapeHtml(p.abstract ?? "")}</p>
</div>`;
}

function lineItem(p: Paper): string {
  const tag = p.score !== undefined ? `score ${p.score}` : "unscored";
  return `<li><a href="${p.link}">${escapeHtml(p.title)}</a> (${tag})</li>`;
}
