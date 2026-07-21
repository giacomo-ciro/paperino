<h1 align="center">paperino</h1>

> Every new arXiv paper, every day, filtered by Claude Code down to what's actually worth your time.


<p align="center">
  <img src="public/paperino.png" alt="Paperino banner" width="100%">
</p>

I work on a 3D vision project. On average, ~200 new papers are published daily in the cs.CV category.

Of those, ~40 look relevant from the title, and fewer than 5 are actually worth reading after scanning the abstract.

Existing tools based on similarity search or embeddings (Scholar Inbox, arXiv Sanity, etc.) aren't precise enough.

Claude Code delivers hyper-precise filtering tailored to your exact research project, running fresh every day.

Scanning the results then takes just 5-10 minutes, and you stay up to date with the latest research.

## Usage
Paperino is a CLI utility, fully configurable via a simple .toml file. For now, it only produces an HTML digest; email delivery is coming soon.

You can run it manually:
```
paperino
```

Useful flags:
```
paperino --configure    # open the config file in your default editor
paperino --logs         # tail the log file; no pipeline run
paperino --force        # discard the run/digest for the selected window(s) and start fresh
paperino --only-fetch   # only fetch papers, skip the scoring pipeline
paperino --quiet        # suppress progress output; print only the digest path
paperino -y             # skip the confirmation prompt and run immediately
```

Or, as I do, run every weekday at 9:30 AM. Open the crontab:
```bash
crontab -e
```
and add:
```bash
# minute 30, hour 9, Mon-Fri
30 9 * * 1-5 paperino -y --quiet
```
> **Note:** arXiv announces new submissions at 20:00 ET on Sun/Mon/Tue/Wed/Thu. Running at 9:30 AM CET (3:30 ET) ensures the run always lands after the prior evening's announcement, catching all five announcements without needing to run on weekends.

## How It Works

**Preliminaries:** arXiv publishes new papers 5 times a week, on Sun, Mon, Tue, Wed and Thu at 20:00 CET. Each publication includes papers submitted during the preceding submission window (14:00 CET to 14:00 the following day), except weekend submissions, which are aggregated and published Monday night. Full details on the [official page](https://info.arxiv.org/help/availability.html#Announcement%20Schedule).

Paperino is minimal, built to work efficiently. It follows a 3-step process:

1. **Fetching papers:** fetch all arXiv papers published in a given window (by default, the latest submission window relative to when the command is run). This step only filters by arXiv category (cs.LM, cs.CV, etc.).
2. **Coarse filtering:** Claude receives your research context and a batch of titles per call (default 20), and outputs a binary relevant/not-relevant judgment. This step is kept coarse: Claude defaults to marking papers as potentially relevant when unsure.
3. **Fine filtering:** Claude receives a smaller batch of title+abstract pairs per call and scores each paper on a scale of 1-10. Papers scoring above 6 get a full summary in the HTML digest; the rest get a one-line mention.

All aforementioned parameters are configurable (what model to use, papers per call, max papers, threshold score etc.):
```
paperino --configure
```

## Acknowledgments
This tool was initially inspired by [AlessandroMorosini/arxiv-digest](https://github.com/AlessandroMorosini/arxiv-digest). Code-wise, I took inspiration from [kunchenguid/gnhf](https://github.com/kunchenguid/gnhf).
