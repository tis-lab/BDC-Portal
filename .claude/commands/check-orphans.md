# Check Orphans

Find work that isn't wired into the deliverable roll-up. Report only — never link, label,
or close anything without asking first.

This exists so reporting stays a read of issue state rather than an ongoing bookkeeping
chore. It answers one question: **is anything being worked on that a report wouldn't see?**

It deliberately does not check for Stories without sub-issues, Epics without Stories, missing
due dates, or project-board field drift. Those belong to the project managers.

## 1. Build the set of linked issues

Every issue reachable as a sub-issue of something in `tis-lab/BDC-Portal`. Only issues with
children are fetched, so this is ~17 API calls rather than one per issue.

```bash
gh api --paginate "repos/tis-lab/BDC-Portal/issues?state=all&per_page=100" \
  --jq '.[] | select(.sub_issues_summary.total > 0) | .number' \
| while read -r n; do
    gh api "repos/tis-lab/BDC-Portal/issues/$n/sub_issues" \
      --jq '.[] | "\(.repository_url | sub("https://api.github.com/repos/";""))#\(.number)"'
  done | sort -u > /tmp/linked.txt
```

`repository_url` matters — sub-issue numbers collide across repositories.

## 2. Orphans in owned repositories

An open issue in an owned repo with no link to BDC-Portal. Two labels exclude an issue, and
both are valid answers rather than gaps:

- `Unscoped` — real work, deliberately outside deliverable reporting. Says nothing about why;
  the reason lives in the other labels or the body. This is the catch-all, and it exists so a
  deliberate decision doesn't resurface on every report.
- `Future` — beyond the current period, or blocked on a precondition that doesn't exist yet.

```bash
for r in study-palette bdc-dp-core bdc-dp-middleware; do
  gh issue list --repo tis-lab/$r --state open --limit 200 --json number,title,labels \
    --jq ".[] | select([.labels[].name] | (index(\"Future\") or index(\"Unscoped\")) | not) | \"tis-lab/$r#\(.number)\t\(.title)\""
done | sort > /tmp/open.txt

join -v1 -t$'\t' /tmp/open.txt /tmp/linked.txt
```

Note `gh --jq` does not accept `--arg`; interpolate the repo name in the shell. Also note
`gh issue edit` has no `--json` flag — passing one fails silently under `2>&1 | tail`.

For each result, propose one of: link it to the lowest existing BDC-Portal issue, label it
`Unscoped` or `Future`, or leave it and say why. Present the list and wait — do not act.

An issue that doesn't fit any deliverable cleanly is a signal worth voicing rather than
filing. Say so instead of attaching it to the nearest Epic.

## 3. Stale upstream trackers

`Tracking`-labelled issues point at work in repositories we don't control. When the upstream
issue closes, ours is usually resolvable, and nothing notifies us.

```bash
gh issue list --repo tis-lab/study-palette --state open --label Tracking \
  --json number,title,body --jq '.[] | "== #\(.number) \(.title)\n\(.body)"' \
  | grep -oE '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+' | sort -u
```

Check each reference's state and flag any that are closed:

```bash
gh issue view <N> --repo <owner>/<repo> --json number,state,stateReason,closedAt
```

## 4. Work in coordinated repositories

Coordinated repos (`monarch-bdc-kg`, `BDC-VarLib`, `linkml/dm-bip`,
`RTIInternational/NHLBI-BDC-DMC-HM`, `RTIInternational/NHLBI-BDC-DMC-HV`) mostly contain work
that has nothing to do with this project. **Do not sweep them** — an unlinked issue there is
the normal case, not a finding.

Instead, look only at what the user is personally working on, and ask:

```bash
gh search issues --assignee @me --state open --limit 100 \
  --json repository,number,title,updatedAt \
  --jq '.[] | select(.repository.nameWithOwner | test("monarch-bdc-kg|BDC-VarLib|dm-bip|NHLBI-BDC-DMC")) | "\(.repository.nameWithOwner)#\(.number)\t\(.updatedAt[:10])\t\(.title)"'
```

Filter out anything already in `/tmp/linked.txt`, then present the remainder as a short list
with a suggested deliverable for each, phrased as a question. Most will be "no" — the user
has other projects, and the default answer is to leave it alone. Only work that *directly*
serves an Aim 1 deliverable should be linked.

## 5. Linking, once approved

Sub-issue creation takes the child's database `id`, not its number:

```bash
gh api repos/<owner>/<repo>/issues/<child-number> --jq .id
gh api repos/tis-lab/BDC-Portal/issues/<parent-number>/sub_issues \
  --method POST -F sub_issue_id=<id>
```

Cross-*repository* and cross-*organization* sub-issues both work — verified 2026-09-17 by
linking `linkml/dm-bip#374` under `tis-lab/BDC-Portal#7`. Cross-org is undocumented but
functional, so coordinated repos in other organizations link natively and need no fallback.

An issue may have **only one parent**. Adding a second returns HTTP 422. When the target is
already a sub-issue somewhere, link the top of its existing chain instead of re-parenting —
that pulls the subtree in without destroying local structure. Check before assuming a link
will land, and if re-parenting looks necessary, ask: it usually means the work belongs to a
different grant.

Limits: 100 sub-issues per parent, 8 levels of nesting.

## 6. Report

Keep it short. Counts, then the lists, then the questions. If nothing is orphaned, say so in
one line and stop.
