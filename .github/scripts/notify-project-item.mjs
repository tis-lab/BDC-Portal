// Comments on issues newly added to an org GitHub Project (v2), @mentioning
// NOTIFY_USER with the title, description and a link to the project item.
import { appendFileSync } from "node:fs";

const PROJECT_TOKEN = process.env.PROJECT_TOKEN;
const REPO_TOKEN = process.env.REPO_TOKEN;
const ORG = process.env.ORG || "tis-lab";
const PROJECT_NUMBER = parseInt(process.env.PROJECT_NUMBER ?? "", 10);
const NOTIFY_USER = (process.env.NOTIFY_USER || "").replace(/^@/, "").trim();
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 24);
const MAX_CHARS = Number(process.env.MAX_CHARS || 2000);
const DRY_RUN = process.env.DRY_RUN === "true";
const CURRENT_REPO = (process.env.GITHUB_REPOSITORY || "").toLowerCase();

const marker = itemId => `<!-- project-item-notify:${itemId} -->`;

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

async function postComment(token, repo, number, text) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: text }),
  });
  if (!res.ok) throw new Error(`Comment on ${repo}#${number} failed (${res.status}): ${await res.text()}`);
}

// ---------- Text helpers ----------
// Zero-width space after "@" so copied text and names don't notify anyone.
export const defang = s => String(s ?? "").replace(/@/g, "@\u200b");

export function quoteDescription(body) {
  let desc = String(body ?? "").replace(/\r/g, "");
  if (!desc.trim()) return "> _No description provided._";
  if (desc.length > MAX_CHARS) {
    desc = desc.slice(0, MAX_CHARS) + "\n\n… (truncated; see the issue for the full description)";
  }
  return defang(desc).split("\n").map(l => `> ${l}`).join("\n");
}

export function buildComment({ itemId, itemDbId, adder, issue }) {
  const projectUrl = `https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}?pane=issue&itemId=${itemDbId}`;
  const author = issue.author?.login ? defang(`@${issue.author.login}`) : "unknown";
  const addedBy = adder ? ` by ${defang(`@${adder}`)}` : "";
  return [
    marker(itemId),
    `@${NOTIFY_USER}, this issue was added to project ${PROJECT_NUMBER}${addedBy} and needs to be sync'd to Jira.`,
    "",
    `**Title:** ${defang(issue.title)}`,
    "",
    "**Description:**",
    "",
    quoteDescription(issue.body),
    "",
    `Issue: ${issue.url} (opened by ${author})`,
    `Project: [View in project ${PROJECT_NUMBER}](${projectUrl})`,
    "",
  ].join("\n");
}

// ---------- Main ----------
function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function main() {
  if (!PROJECT_TOKEN) fail("PROJECT_TOKEN is not set.");
  if (!NOTIFY_USER) fail("Repo variable NOTIFY_USER is not set.");
  if (!Number.isInteger(PROJECT_NUMBER)) fail("PROJECT_NUMBER is not set.");

  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  const stats = { candidates: 0, notified: 0, already: 0, skippedSelf: 0, redacted: 0, errors: 0, log: [] };

  // 1. Find issue items added within the lookback window.
  const candidates = [];
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
                content { ... on Issue { id } }
              }
            }
          }
        }
      }`,
      { org: ORG, num: PROJECT_NUMBER, after });
    const project = data.organization?.projectV2;
    if (!project) fail(`Project #${PROJECT_NUMBER} not found in ${ORG} (or token lacks access).`);
    for (const it of project.items.nodes) {
      if (Date.parse(it.createdAt) < cutoff) continue;
      if (it.type === "REDACTED") { stats.redacted++; continue; }
      if (it.type !== "ISSUE" || !it.content?.id) continue;
      candidates.push(it);
    }
    after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (after);
  stats.candidates = candidates.length;

  // 2. Notify for each one not already notified.
  for (const it of candidates) {
    const adder = it.creator?.login ?? null;
    try {
      if (adder && adder.toLowerCase() === NOTIFY_USER.toLowerCase()) { stats.skippedSelf++; continue; }

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

      if (issue.comments.nodes.some(c => c.body.includes(marker(it.id)))) { stats.already++; continue; }

      const repo = issue.repository.nameWithOwner;
      const token = repo.toLowerCase() === CURRENT_REPO && REPO_TOKEN ? REPO_TOKEN : PROJECT_TOKEN;
      const text = buildComment({ itemId: it.id, itemDbId: it.databaseId, adder, issue });

      if (!DRY_RUN) await postComment(token, repo, issue.number, text);
      stats.notified++;
      const line = `${repo}#${issue.number} "${issue.title}" (added by ${adder ?? "unknown"})`;
      stats.log.push(line);
      console.log((DRY_RUN ? "[dry-run] would notify: " : "notified: ") + line);
    } catch (e) {
      stats.errors++;
      console.error(`::warning::Item ${it.id}: ${e.message}`);
    }
  }

  const summary =
    `### Project ${PROJECT_NUMBER} notifications${DRY_RUN ? " (dry run)" : ""}\n\n` +
    `Added in last ${LOOKBACK_HOURS}h: ${stats.candidates} · Notified: ${stats.notified} · ` +
    `Already notified: ${stats.already} · Added by ${NOTIFY_USER} (skipped): ${stats.skippedSelf} · ` +
    `Hidden from token: ${stats.redacted} · Errors: ${stats.errors}\n\n` +
    (stats.log.length ? "```\n" + stats.log.join("\n") + "\n```\n" : "");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

  if (stats.redacted > 0) {
    console.error(`::warning::${stats.redacted} recent item(s) are hidden from PROJECT_TOKEN. ` +
      "Give the token Issues access to the repos they come from.");
  }
  if (stats.errors > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => fail(e.stack || e.message));
}
