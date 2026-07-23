# Set up paperino for this project

paperino is a CLI tool that fetches newly published arXiv papers every day and
filters them down to what's relevant to a specific research project, using
Claude to judge relevance from title and abstract. It's configured via a
single TOML file at `~/.paperino/config.toml`.

Do the following:

1. Run `paperino --configure` once, non-interactively (it just bootstraps
   `~/.paperino/config.toml` from a template and exits — no need to actually
   edit anything in that step).
2. Look around this project (code, README, docs, papers, notes — whatever is
   here) to understand what it's about.
3. Edit `~/.paperino/config.toml` and fill in:
   - `RESEARCH.ARXIV_CAT`: the arXiv categories relevant to this project
     (browse the taxonomy at https://arxiv.org/category_taxonomy if unsure).
   - `RESEARCH.RESEARCH_INTERESTS`: a short, specific research summary
     describing this project, precise enough for Claude to judge whether a
     new arXiv paper is relevant to it. A couple of sentences is enough —
     favor specificity over length.

Leave every other field in the config at its default. Don't run `paperino`
itself (the full fetch-and-score pipeline) — just get the config filled in.
