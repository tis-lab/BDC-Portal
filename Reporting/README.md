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

Only issues on the [project board](https://github.com/orgs/tis-lab/projects/7) that are in the
**current sprint** are listed. The report runs every Tuesday at 9am PT; status is reviewed live in the Thursday meeting.

- **Done** – issues assigned to the person that were closed, and pull requests they wrote that
  were merged, from the start of the sprint until the report. Comments they wrote on those issues
  during the sprint are listed underneath.
- **Next** – open issues assigned to the person, each with its board Status in brackets, e.g.
  `[In Progress]`. Comments they wrote on it in the last 7 days are listed underneath; an issue
  with no comments underneath has had no update from them that week. Closed issues are not listed.
- **Other comments** – comments (last 7 days) on sprint issues that are assigned to someone else
  (or to nobody), such as reviews and feedback on a teammate's ticket.
- **Blockers** – open sprint issues whose **board Status is Blocked**. The board Status is the
  source of truth: once it changes to In Progress or Complete the issue is no longer listed. The
  `Blocked` label and comments saying "blocked" or starting `Blocker:` (last 7 days) also count,
  but only when the issue has no Status set. Each issue is listed once.
- **Check status** – appears only when a comment or the `Blocked` label says blocked but the board
  Status says otherwise (and is not Complete). It is a nudge to update the Status.

Only activity found in GitHub is listed; nothing is inferred. Issues with no assignee, or not in
the current sprint, do not appear.

## How to flag a blocker

Set the board Status to `Blocked`, add the `Blocked` label, or comment on it with a line such as:

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

The workflow reads issues with the built-in `GITHUB_TOKEN` and the project board (sprint and status) with the existing `PROJECT_TOKEN` secret.

> **This repository is public.** Reports and blocker text are visible to anyone.
> Do not put credentials, participant data, or sensitive discussion in a blocker.
