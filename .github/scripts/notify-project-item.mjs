// Notifies NOTIFY_USER about activity on an org GitHub Project (v2):
//   - issues newly added to the project
//   - changes to ITAC Jira Responsible, Sprint, Quarter Start, Quarter End and story points
//
// Projects have no change history in the API, so field changes are detected by
// comparing each run's values with a snapshot saved by the previous run
// (STATE_FILE, persisted between runs by the workflow's cache steps).
//
// NOTIFY_MODE:
//   digest (default)  one comment per run on a dedicated "notifications" issue
//   issue             a comment on each affected issue
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const env = process.env;
const PROJECT_TOKEN = env.PROJECT_TOKEN;
const REPO_TOKEN = env.REPO_TOKEN;
const ORG = env.ORG || "tis-lab";
const PROJECT_NUMBER = parseInt(env.PROJECT_NUMBER ?? "", 10);
const NOTIFY_USER = (env.NOTIFY_USER || "").replace(/^@/, "").trim();
const NOTIFY_MODE = (env.NOTIFY_MODE || "digest").trim().toLowerCase();
const LOOKBACK_HOURS = Number(env.LOOKBACK_HOURS || 24);
const MAX_CHARS = Number(env.MAX_CHARS || 2000);
const DRY_RUN = env.DRY_RUN === "true";
const CURRENT_REPO = env.GITHUB_REPOSITORY || "";
const STATE_FILE = env.STATE_FILE || ".state/project-notify-state.json";
const DIGEST_LABEL = env.DIGEST_LABEL || `project-${PROJECT_NUMBER}-notifications`;
const COMMENT_LIMIT = 60000; // GitHub's hard limit is 65,536 characters

// Tracked project fields, matched by exact name.
const TRACKED = [
  { key: "responsible", label: "ITAC Jira Responsible", field: env.FIELD_RESPONSIBLE || "ITAC Jira Responsible", types: ["SINGLE_SELECT"] },
  { key: "sprint", label: "Sprint", field: env.FIELD_SPRINT || "Sprint", types: ["SINGLE_SELECT", "ITERATION"] },
  { key: "qStart", label: "Quarter Start", field: env.FIELD_Q_START || "Quarter Start", types: ["TEXT"] },
  { key: "qEnd", label: "Quarter End", field: env.FIELD_Q_END || "Quarter End", types: ["TEXT"] },
  { key: "points", label: "Story points", field: env.FIELD_POINTS || "Jira Story Points (# Days)", types: ["NUMBER"] },
];

// Shown in notifications but not tracked for changes. Optional: if missing,
// notifications simply leave the ITAC Jira link out.
const DISPLAY = {
  jiraUrl: env.FIELD_JIRA_URL || "ITAC Jira URL",
  jiraStatus: env.FIELD_JIRA_STATUS || "ITAC Jira",
};

const addedMarker = itemId => `<!-- project-item-notify:${itemId} -->`;
const projectLink = dbId => `https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}?pane=issue&itemId=${dbId}`;

// ---------- API helpers ----------
async function gql(token, query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`GraphQL (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

async function rest(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${path} failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function postComment(token, repo, number, text) {
  if (DRY_RUN) return;
  await rest(token, "POST", `/repos/${repo}/issues/${number}/comments`, { body: text });
}

// ---------- Text helpers ----------
// Zero-width space after "@" so copied text and names don't notify anyone.
export const defang = s => String(s ?? "").replace(/@/g, "@\u200b");
const show = v => (v === "" || v == null ? "_(empty)_" : defang(v));

export function quoteDescription(body) {
  let desc = String(body ?? "").replace(/\r/g, "");
  if (!desc.trim()) return "> _No description provided._";
  if (desc.length > MAX_CHARS) {
    desc = desc.slice(0, MAX_CHARS) + "\n\n… (truncated; see the issue for the full description)";
  }
  return defang(desc).split("\n").map(l => `> ${l}`).join("\n");
}

function itemTitle(it) {
  const c = it.content ?? {};
  if (c.repository) return `[${c.repository.nameWithOwner}#${c.number}](${c.url}) ${defang(c.title)}`;
  return `Draft issue: ${defang(c.title ?? "(untitled)")}`;
}

// GitHub issue, ITAC Jira and project links, one per line.
export function linkLines(item, info) {
  const c = item.content ?? {};
  const lines = [];
  lines.push(c.url ? `GitHub issue: ${c.url}` : "GitHub issue: _none (draft issue)_");
  if (info?.jiraUrl) {
    const stale = info.jiraStatus?.toLowerCase() === "error" ? " (ITAC Jira ID is marked Error; link may be out of date)" : "";
    lines.push(`ITAC Jira: ${info.jiraUrl}${stale}`);
  }
  lines.push(`Project: [View in project ${PROJECT_NUMBER}](${projectLink(item.databaseId)})`);
  return lines.join("\n");
}

function changeLines(changes) {
  return changes.map(ch => `- **${ch.label}:** ${show(ch.from)} → ${show(ch.to)}`).join("\n");
}

function additionDetails(add) {
  const author = add.issue.author?.login ? defang(`@${add.issue.author.login}`) : "unknown";
  const by = add.adder ? defang(`@${add.adder}`) : "unknown";
  return [
    `**Title:** ${defang(add.issue.title)}`,
    "",
    "**Description:**",
    "",
    quoteDescription(add.issue.body),
    "",
    `Added by ${by} · Opened by ${author}`,
    "",
    linkLines(add.item, add.info),
  ].join("\n");
}

// Per-issue comments (NOTIFY_MODE=issue)
export function additionComment(add) {
  return [
    addedMarker(add.item.id),
    `@${NOTIFY_USER}, this issue was added to project ${PROJECT_NUMBER}.`,
    "",
    additionDetails(add),
    "",
  ].join("\n");
}

export function changeComment(ch) {
  return [
    `@${NOTIFY_USER}, project ${PROJECT_NUMBER} fields changed on this issue:`,
    "",
    changeLines(ch.changes),
    "",
    linkLines(ch.item, ch.info),
    "",
  ].join("\n");
}

// Digest comments (NOTIFY_MODE=digest); split if too long for one comment.
export function digestComments(additions, changes) {
  const blocks = [];
  for (const add of additions) {
    blocks.push([addedMarker(add.item.id), `#### Added: ${itemTitle(add.item)}`, "", additionDetails(add)].join("\n"));
  }
  for (const ch of changes) {
    blocks.push([
      `#### Changed: ${itemTitle(ch.item)}`,
      "",
      changeLines(ch.changes),
      "",
      linkLines(ch.item, ch.info),
    ].join("\n"));
  }
  const header = `@${NOTIFY_USER}, project ${PROJECT_NUMBER} updates: ` +
    `${additions.length} added, ${changes.length} changed.`;
  const comments = [];
  let current = header;
  for (const b of blocks) {
    if (current.length + b.length + 2 > COMMENT_LIMIT && current !== header) {
      comments.push(current);
      current = `@${NOTIFY_USER}, project ${PROJECT_NUMBER} updates (continued):`;
    }
    current += "\n\n---\n\n" + b;
  }
  comments.push(current + "\n");
  return comments;
}

// ---------- Project data ----------
const FIELD_VALUES = `
  fieldValues(first: 50) {
    nodes {
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { id } } }
      ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { id } } }
    }
  }`;

async function loadFieldIds() {
  const data = await gql(PROJECT_TOKEN,
    `query($org: String!, $num: Int!) {
      organization(login: $org) {
        projectV2(number: $num) {
          title
          fields(first: 100) { nodes { ... on ProjectV2FieldCommon { id name dataType } } }
        }
      }
    }`,
    { org: ORG, num: PROJECT_NUMBER });
  const project = data.organization?.projectV2;
  if (!project) fail(`Project #${PROJECT_NUMBER} not found in ${ORG} (or token lacks access).`);
  const byName = Object.fromEntries(project.fields.nodes.filter(f => f?.name).map(f => [f.name, f]));
  const ids = {};
  for (const t of TRACKED) {
    const f = byName[t.field];
    if (!f) fail(`Field "${t.field}" not found on project "${project.title}".`);
    if (!t.types.includes(f.dataType)) {
      fail(`Field "${t.field}" must be ${t.types.join(" or ")} (is ${f.dataType}).`);
    }
    ids[t.key] = f.id;
  }
  for (const [key, name] of Object.entries(DISPLAY)) {
    if (byName[name]) ids[key] = byName[name].id;
    else console.error(`::warning::Field "${name}" not found; notifications will not include it.`);
  }
  return ids;
}

async function loadItems() {
  const items = [];
  let after = null;
  do {
    const data = await gql(PROJECT_TOKEN,
      `query($org: String!, $num: Int!, $after: String) {
        organization(login: $org) {
          projectV2(number: $num) {
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id databaseId createdAt type
                creator { login }
                content {
                  ... on Issue { id number title url repository { nameWithOwner } }
                  ... on PullRequest { id number title url repository { nameWithOwner } }
                  ... on DraftIssue { id title }
                }
                ${FIELD_VALUES}
              }
            }
          }
        }
      }`,
      { org: ORG, num: PROJECT_NUMBER, after });
    const page = data.organization.projectV2.items;
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

function fieldValue(item, fieldId) {
  if (!fieldId) return "";
  const v = (item.fieldValues?.nodes ?? []).find(n => n?.field?.id === fieldId);
  const raw = v ? [v.text, v.name, v.title, v.number].find(x => x !== undefined && x !== null) : undefined;
  return raw === undefined ? "" : String(raw).trim();
}

export function snapshot(item, fieldIds) {
  return Object.fromEntries(TRACKED.map(t => [t.key, fieldValue(item, fieldIds[t.key])]));
}

export function displayInfo(item, fieldIds) {
  return { jiraUrl: fieldValue(item, fieldIds.jiraUrl), jiraStatus: fieldValue(item, fieldIds.jiraStatus) };
}

// Only compares keys the previous snapshot has, so adding or renaming a
// tracked field records a baseline for it instead of reporting every item.
export function diff(prev, curr) {
  return TRACKED
    .filter(t => t.key in prev && (prev[t.key] ?? "") !== (curr[t.key] ?? ""))
    .map(t => ({ label: t.label, from: prev[t.key] ?? "", to: curr[t.key] ?? "" }));
}

// ---------- State ----------
function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (s.org !== ORG || s.project !== PROJECT_NUMBER || typeof s.items !== "object") return null;
    return s;
  } catch {
    return null;
  }
}

function saveState(items) {
  if (DRY_RUN) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ org: ORG, project: PROJECT_NUMBER, savedAt: new Date().toISOString(), items }));
}

// ---------- Digest issue ----------
async function findDigestIssue() {
  const list = await rest(REPO_TOKEN, "GET",
    `/repos/${CURRENT_REPO}/issues?labels=${encodeURIComponent(DIGEST_LABEL)}&state=open&per_page=1&sort=created&direction=asc`);
  return list?.[0]?.number ?? null;
}

async function createDigestIssue() {
  try {
    await rest(REPO_TOKEN, "POST", `/repos/${CURRENT_REPO}/labels`,
      { name: DIGEST_LABEL, color: "0e8a16", description: `Automated project ${PROJECT_NUMBER} notifications` });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = label already exists
  }
  const issue = await rest(REPO_TOKEN, "POST", `/repos/${CURRENT_REPO}/issues`, {
    title: `Project ${PROJECT_NUMBER} notifications`,
    labels: [DIGEST_LABEL],
    body:
      `Automated updates for https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}. ` +
      `@${NOTIFY_USER} is mentioned in every update.\n\n` +
      `Keep this issue open. If it is closed, the workflow creates a new one.`,
  });
  return issue.number;
}

async function digestMarkers(number) {
  const [owner, name] = CURRENT_REPO.split("/");
  const data = await gql(REPO_TOKEN,
    `query($o: String!, $n: String!, $num: Int!) {
      repository(owner: $o, name: $n) { issue(number: $num) { comments(last: 100) { nodes { body } } } }
    }`,
    { o: owner, n: name, num: number });
  return (data.repository?.issue?.comments?.nodes ?? []).map(c => c.body).join("\n");
}

// ---------- Main ----------
function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function tokenFor(repo) {
  return repo.toLowerCase() === CURRENT_REPO.toLowerCase() && REPO_TOKEN ? REPO_TOKEN : PROJECT_TOKEN;
}

async function main() {
  if (!PROJECT_TOKEN) fail("PROJECT_TOKEN is not set.");
  if (!NOTIFY_USER) fail("Repo variable NOTIFY_USER is not set.");
  if (!Number.isInteger(PROJECT_NUMBER)) fail("PROJECT_NUMBER is not set.");
  if (!["digest", "issue"].includes(NOTIFY_MODE)) fail(`NOTIFY_MODE must be "digest" or "issue" (got "${NOTIFY_MODE}").`);
  if (NOTIFY_MODE === "digest" && (!REPO_TOKEN || !CURRENT_REPO)) fail("Digest mode needs REPO_TOKEN and GITHUB_REPOSITORY.");

  const stats = { items: 0, added: 0, changed: 0, alreadyNotified: 0, skippedSelf: 0, redacted: 0, draftsSkipped: 0, errors: 0 };
  const log = [];
  const fieldIds = await loadFieldIds();
  const items = await loadItems();
  const prevState = loadState();
  const baseline = !prevState;

  // 1. Snapshot every item and diff against the previous run.
  const newState = {};
  const changes = [];
  for (const it of items) {
    if (it.type === "REDACTED" || !it.content) { stats.redacted++; continue; }
    stats.items++;
    const snap = snapshot(it, fieldIds);
    newState[it.id] = snap;
    const prev = prevState?.items?.[it.id];
    if (prev) {
      const d = diff(prev, snap);
      if (d.length) changes.push({ item: it, changes: d, prev, info: displayInfo(it, fieldIds) });
    }
  }

  // 2. Issues added within the lookback window, not added by NOTIFY_USER.
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const addCandidates = items.filter(it => it.type === "ISSUE" && it.content?.id && Date.parse(it.createdAt) >= cutoff);
  let digestNumber = NOTIFY_MODE === "digest" ? await findDigestIssue() : null;
  const digestText = digestNumber ? await digestMarkers(digestNumber) : "";

  const additions = [];
  for (const it of addCandidates) {
    if (it.creator?.login?.toLowerCase() === NOTIFY_USER.toLowerCase()) { stats.skippedSelf++; continue; }
    try {
      const { node: issue } = await gql(PROJECT_TOKEN,
        `query($id: ID!) {
          node(id: $id) {
            ... on Issue {
              number title body url
              author { login }
              repository { nameWithOwner }
              comments(last: 100) { nodes { body } }
            }
          }
        }`,
        { id: it.content.id });
      const m = addedMarker(it.id);
      if (digestText.includes(m) || issue.comments.nodes.some(c => c.body.includes(m))) { stats.alreadyNotified++; continue; }
      additions.push({ item: it, issue, adder: it.creator?.login ?? null, info: displayInfo(it, fieldIds) });
    } catch (e) {
      stats.errors++;
      console.error(`::warning::Item ${it.id}: ${e.message}`);
    }
  }

  // 3. Send notifications.
  if (NOTIFY_MODE === "digest") {
    if (additions.length || changes.length) {
      const comments = digestComments(additions, changes);
      try {
        if (!digestNumber && !DRY_RUN) digestNumber = await createDigestIssue();
        for (const c of comments) await postComment(REPO_TOKEN, CURRENT_REPO, digestNumber, c);
        stats.added = additions.length;
        stats.changed = changes.length;
      } catch (e) {
        // Nothing is lost: state is not saved, so the same changes are retried next run.
        console.error(`::error::Posting digest failed: ${e.message}`);
        process.exit(1);
      }
      if (DRY_RUN) console.log("[dry-run] digest would be:\n\n" + comments.join("\n\n=====\n\n"));
    }
  } else {
    for (const add of additions) {
      try {
        const repo = add.issue.repository.nameWithOwner;
        await postComment(tokenFor(repo), repo, add.issue.number, additionComment(add));
        stats.added++;
      } catch (e) {
        stats.errors++;
        console.error(`::warning::Addition ${add.item.id}: ${e.message}`);
      }
    }
    for (const ch of changes) {
      const c = ch.item.content;
      if (!c.repository) {
        stats.draftsSkipped++; // draft issues have no comment thread
        continue;
      }
      try {
        await postComment(tokenFor(c.repository.nameWithOwner), c.repository.nameWithOwner, c.number, changeComment(ch));
        stats.changed++;
      } catch (e) {
        stats.errors++;
        newState[ch.item.id] = ch.prev; // keep old snapshot so it's retried next run
        console.error(`::warning::Change on ${ch.item.id}: ${e.message}`);
      }
    }
  }

  for (const a of additions) log.push(`added: ${itemTitle(a.item)}`);
  for (const ch of changes) log.push(`changed: ${itemTitle(ch.item)} | ${ch.changes.map(x => `${x.label}: "${x.from}" -> "${x.to}"`).join("; ")}`);
  for (const l of log) console.log((DRY_RUN ? "[dry-run] " : "") + l);

  saveState(newState);

  const summary =
    `### Project ${PROJECT_NUMBER} notifications (${NOTIFY_MODE} mode)${DRY_RUN ? " (dry run)" : ""}\n\n` +
    (baseline ? "No saved state found: recorded a baseline, so no field changes are reported this run.\n\n" : "") +
    `Items: ${stats.items} · Added: ${additions.length} · Changed: ${changes.length} · ` +
    `Already notified: ${stats.alreadyNotified} · Added by ${NOTIFY_USER} (skipped): ${stats.skippedSelf} · ` +
    `Hidden from token: ${stats.redacted} · Draft changes skipped: ${stats.draftsSkipped} · Errors: ${stats.errors}\n\n` +
    (log.length ? "```\n" + log.join("\n") + "\n```\n" : "");
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);

  if (stats.redacted > 0) {
    console.error(`::warning::${stats.redacted} item(s) are hidden from PROJECT_TOKEN. ` +
      "Give the token Issues access to the repos they come from.");
  }
  if (stats.errors > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => fail(e.stack || e.message));
}
