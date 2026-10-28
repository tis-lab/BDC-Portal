# Reporting

Automated status reports for the BDC Data Portal team, generated from GitHub activity
(see *SOP – Team Status Reporting and Standups*).

| Path | Purpose |
|---|---|
| `contributors.txt` | GitHub handles included in each report (one per line, `#` for notes) |
| `reports/YYYY-MM-DD.md` | One report per run: Done / Next / Blockers per person |

The workflow is [`.github/workflows/status-report.yml`](../.github/workflows/status-report.yml).
It runs on a schedule and can be started by hand from the **Actions** tab (**Run workflow**).

## What each section means

Covers the last 5 days (the report runs Tuesday 9am PT and Thursday 2pm PT).

- **Done** – issues assigned to the person that were closed, and pull requests they wrote that
  were merged. Comments they wrote on those issues are listed underneath.
- **Next** – open issues assigned to the person, with their recent comments underneath.
- **Other comments** – comments they wrote on issues that are not assigned to them.
- **Blockers** – open issues labelled `Blocked`, plus any comment they wrote that has a line
  starting with `Blocker:` or that contains the word "blocked".

Only activity found in GitHub is listed; nothing is inferred. Work that isn't in GitHub
(a talk, a meeting) is not captured. Issues with no assignee do not appear.

## How to flag a blocker

Either label the issue `Blocked`, or comment on it with a line such as:

```
Blocker: waiting on @ShahimEssaid for API access
```

Blockers are also posted to the group Slack channel (see below).

## Repositories covered

`tis-lab/BDC-Portal` and `tis-lab/study-palette`. Edit `REPOS` in the workflow to change this.

## Setup (one time, repo admin)

| Secret | Needed for |
|---|---|
| `SLACK_WEBHOOK_URL` | Posting blockers to Slack (Slack app → Incoming Webhooks → pick the group channel). Optional: without it, Slack posting is skipped. |

The workflow reads only public repositories with the built-in `GITHUB_TOKEN`.

> **This repository is public.** Reports and blocker text are visible to anyone.
> Do not put credentials, participant data, or sensitive discussion in a blocker.
