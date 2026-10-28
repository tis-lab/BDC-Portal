// Builds Reporting/reports/<date>.md from GitHub activity and (optionally) posts blockers to Slack.
// Only data returned by the GitHub API is reported; nothing is generated or inferred.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const {
  GH_TOKEN,
  REPOS,
  SINCE_DAYS = "4",
  SLACK_WEBHOOK_URL = "",
  GITHUB_REPOSITORY,
  GITHUB_OUTPUT,
} = process.env;
const repos = REPOS.split(/\s+/).filter(Boolean);
const users = readFileSync("Reporting/contributors.txt", "utf8")
  .split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);

const since = new Date(Date.now() - Number(SINCE_DAYS) * 86400000);
const sinceDate = since.toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const repoQ = repos.map((r) => `repo:${r}`).join(" ");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function search(q) {
  await sleep(2200); // stay under the 30 req/min search limit
  return (await gh(`/search/issues?per_page=100&q=${encodeURIComponent(q)}`)).items;
}
const short = (i) => `${i.repository_url.split("/").slice(-2).join("/")}#${i.number}`;
const line = (i) => `- [${short(i)}](${i.html_url}) ${i.title}`;

// Comments with a "Blocker:" line, written by contributors since the last report.
const blockerComments = [];
for (const repo of repos) {
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/repos/${repo}/issues/comments?since=${since.toISOString()}&per_page=100&page=${page}`);
    for (const c of batch) {
      const m = c.body.match(/^[ \t>*_-]*blockers?\**\s*:\s*(.+)$/im);
      if (m && users.includes(c.user.login)) {
        blockerComments.push({ user: c.user.login, text: m[1].trim(), url: c.html_url });
      }
    }
    if (batch.length < 100) break;
  }
}

let md = `# Status report ${today}\n\nActivity since ${sinceDate} in ${repos.map((r) => `\`${r}\``).join(", ")}.\n`;
const slack = [];

for (const u of users) {
  const done = [
    ...(await search(`${repoQ} assignee:${u} is:issue closed:>=${sinceDate}`)),
    ...(await search(`${repoQ} author:${u} is:pr is:merged merged:>=${sinceDate}`)),
  ];
  const next = await search(`${repoQ} assignee:${u} is:issue is:open`);
  const blockedIssues = next.filter((i) => i.labels.some((l) => l.name.toLowerCase() === "blocked"));
  const comments = blockerComments.filter((c) => c.user === u);

  md += `\n## @${u}\n\n**Done**\n${done.length ? done.map(line).join("\n") : "- _nothing closed or merged_"}\n`;
  md += `\n**Next**\n${next.length ? next.map(line).join("\n") : "- _no open assigned issues_"}\n`;
  md += `\n**Blockers**\n`;
  const blk = [
    ...blockedIssues.map((i) => `- [${short(i)}](${i.html_url}) ${i.title} (labelled \`blocked\`)`),
    ...comments.map((c) => `- ${c.text} ([comment](${c.url}))`),
  ];
  md += blk.length ? blk.join("\n") + "\n" : "- None\n";
  if (blk.length) slack.push(`*Blockers – ${u}*\n${blk.join("\n")}`);
}

mkdirSync("Reporting/reports", { recursive: true });
const file = `Reporting/reports/${today}.md`;
writeFileSync(file, md);
console.log(`wrote ${file}`);
if (GITHUB_OUTPUT) writeFileSync(GITHUB_OUTPUT, `file=${file}\n`, { flag: "a" });

if (slack.length && SLACK_WEBHOOK_URL) {
  const link = `<https://github.com/${GITHUB_REPOSITORY}/blob/main/${file}|Full report>`;
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `:rotating_light: *BDC Portal blockers (${today})*\n\n${slack.join("\n\n")}\n\n${link}` }),
  });
  console.log(`slack: ${res.status}`);
} else if (slack.length) {
  console.log("blockers found but SLACK_WEBHOOK_URL is not set; skipping Slack");
}
