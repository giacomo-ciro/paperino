# arXiv API notes

## Query syntax (`search_query`)

Field prefixes: `ti:` title, `au:` author, `abs:` abstract, `co:` comment, `jr:` journal ref, `cat:` subject category (e.g. `cs.LG`, `cs.AI`), `rn:` report number, `all:` all fields.

Combine with `AND` / `OR` / `ANDNOT`, group with parentheses, quote phrases (`ti:"quantum criticality"`).

Date range filter: `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` (GMT). `submittedDate` = original submission date of that arXiv ID; `updated`/`lastUpdatedDate` = latest revision date. Decide which one you actually mean for "papers from today" — a revised older paper won't match a `submittedDate` filter for today.

Example: `cat:cs.LG AND submittedDate:[202607060000 TO 202607072359]`

Full reference: https://info.arxiv.org/help/api/user-manual.html#query_details

## `arxiv` python library (v4.0.0)

Pass the query **unencoded** to `Search(query=...)` — the client handles URL encoding.

Two independent knobs:
- `Client(page_size=...)` — results per HTTP request (transport efficiency only, cap 2000).
- `Search(max_results=...)` — total results you want across the whole search. `None` = fetch everything (API hard cap ~300,000).

`Client(...).results(search)` returns an iterator that pages automatically: it keeps requesting subsequent pages (`start` += `page_size`) until either arXiv's reported total is exhausted or a page is empty, capped at `max_results` via `itertools.islice`. You just loop over it — no manual `start` bookkeeping needed.

Built-in rate limiting (`delay_seconds`, default 3s, matches arXiv ToU) and retry-on-failure — don't add your own sleep loop.

Each yielded `Result` has `.title`, `.published`, `.updated`, `.categories`, `.primary_category`, etc.

## Gotchas

- For a daily "new papers" job: category-filtered, single-day queries return small result counts — pagination interplay rarely matters in practice, one request usually suffices.
- arXiv's own daily announcement cycle runs on US Eastern time and posts ~8pm ET; a naive rolling "last 24h" in GMT may not align with what arXiv considers "today's" listing. E.g., papers submitted on Mon 14:00 - Tue 14:00 are batch released on Tue 20:00, and so on for the other days. See the [full schedule](https://info.arxiv.org/help/availability.html#:~:text=to%20various%20factors.-,Announcement%20Schedule,-Submissions%20received%20between).
- `submittedDate` filtering will not miss a paper — every submission gets that timestamp the moment it's uploaded, regardless of when it's later announced. The real risk is boundary drift/duplication: a rolling GMT window doesn't line up with arXiv's ET announcement cutoffs (14:00 ET), so consecutive daily runs can double-count or gap at the edges.
- Full cutoff -> announcement mapping (all ET): Tue 14:00 cutoff -> announced Tue 20:00; Wed -> Wed 20:00; Thu -> Thu 20:00; Fri 14:00 cutoff (covers Thu 14:00 - Fri 14:00) -> held until **Sun 20:00**; Mon 14:00 cutoff (covers Fri 14:00 - Mon 14:00, the whole weekend) -> announced Mon 20:00. Sat/Sun are never a window's *end* — there's no cutoff landing on those days.
