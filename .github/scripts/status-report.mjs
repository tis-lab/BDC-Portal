// Builds Reporting/reports/<date>.md from GitHub activity and (optionally) posts blockers to Slack.
// Only data returned by the GitHub API is reported; nothing is generated or inferred.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const {
  GH_TOKEN,
  REPOS,
  SINCE_DAYS = "5",
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
const RESOLVED = /\b(unblocked|no longer blocked|not blocked|isn'?t blocked|resolved|addressed)\b/i;
const daysAgo = (d) => Math.max(0, Math.floor((Date.now() - new Date(d)) / 86400000));
const ago = (d) => { const n = daysAgo(d); return n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`; };
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Comments written by contributors since the last report (issue and PR conversation comments).
const comments = [];
for (const repo of repos) {
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(`/repos/${repo}/issues/comments?since=${since.toISOString()}&per_page=100&page=${page}`);
    for (const c of batch) {
      if (!users.includes(c.user.login) || new Date(c.created_at) < since) continue;
      const lines = c.body.split("\n").map((l) => l.trim()).filter(Boolean);
      const blockerLine =
        c.body.match(/^[ \t>*_-]*blockers?\**\s*:\s*(.+)$/im)?.[1] ??
        lines.find((l) => /\bblocked\b/i.test(l) && !RESOLVED.test(l));
      const issueUrl = c.html_url.split("#")[0];
      const [, repoName, num] = issueUrl.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
      comments.push({
        user: c.user.login, url: c.html_url, issueUrl, ref: `${repoName}#${num}`,
        snippet: clip(lines[0] ?? ""), blocker: blockerLine ? clip(blockerLine.trim(), 200) : null,
      });
    }
    if (batch.length < 100) break;
  }
}

let md = `# Status report ${today}\n\nActivity since ${sinceDate} in ${repos.map((r) => `\`${r}\``).join(", ")}.\n`;
const slack = [];

for (const u of users) {
  const mine = comments.filter((c) => c.user === u);
  const doneIssues = await search(`${repoQ} assignee:${u} is:issue closed:>=${sinceDate}`);
  const donePrs = await search(`${repoQ} author:${u} is:pr is:merged merged:>=${sinceDate}`);
  // A merged PR that closes one of the listed issues is shown under that issue, not twice.
  for (const pr of donePrs) {
    const m = (pr.body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)/gi);
    for (const [, r, n] of m) {
      const repo = r ?? pr.repository_url.split("/").slice(-2).join("/");
      const issue = doneIssues.find((i) => short(i) === `${repo}#${n}`);
      if (issue) { (issue.prs ??= []).push(pr); pr.folded = true; }
    }
  }
  const done = [...new Map([...doneIssues, ...donePrs.filter((p) => !p.folded)].map((i) => [i.html_url, i])).values()];
  const next = await search(`${repoQ} assignee:${u} is:issue is:open`);
  const blockedIssues = next.filter((i) => i.labels.some((l) => l.name.toLowerCase() === "blocked"));

  const withComments = (i) =>
    line(i) + "\n" +
    (i.prs ?? []).map((p) => `  - merged PR: [${short(p)}](${p.html_url}) ${p.title}\n`).join("") +
    mine.filter((c) => c.issueUrl === i.html_url).map((c) => `  - 💬 ${c.snippet} ([comment](${c.url}))`).map((s) => s + "\n").join("");
  const listed = new Set([...done, ...next].map((i) => i.html_url));
  const other = mine.filter((c) => !listed.has(c.issueUrl));

  md += `\n## @${u}\n\n**Done**\n${done.length ? done.map(withComments).join("").trimEnd() : "- _nothing closed or merged_"}\n`;
  md += `\n**Next**\n${next.length ? next.map(withComments).join("").trimEnd() : "- _no open assigned issues_"}\n`;
  if (other.length) {
    md += `\n**Other comments**\n${other.map((c) => `- ${c.ref}: ${c.snippet} ([comment](${c.url}))`).join("\n")}\n`;
  }
  md += `\n**Blockers**\n`;
  const blocked = new Map(); // issue ref -> { url, title, notes[] }
  const note = (ref, url, title, text) => {
    const e = blocked.get(ref) ?? { url, title, notes: [] };
    e.notes.push(text);
    blocked.set(ref, e);
  };
  for (const i of blockedIssues) {
    const repo = i.repository_url.split("/").slice(-2).join("/");
    const events = await gh(`/repos/${repo}/issues/${i.number}/events?per_page=100`);
    const labeledAt = events.filter((e) => e.event === "labeled" && e.label?.name.toLowerCase() === "blocked").at(-1)?.created_at;
    const after = labeledAt ? await gh(`/repos/${repo}/issues/${i.number}/comments?since=${labeledAt}&per_page=100`) : [];
    const last = after.filter((c) => new Date(c.created_at) > new Date(labeledAt)).at(-1);
    const hint = after.find((c) => new Date(c.created_at) > new Date(labeledAt) && RESOLVED.test(c.body));
    let t = labeledAt ? `labelled \`Blocked\` ${ago(labeledAt)}` : "labelled `Blocked`";
    t += last ? `; last comment by @${last.user.login} ${ago(last.created_at)}` : "; no comments since";
    if (hint) t += ` — ⚠️ possibly resolved: "${clip(hint.body.split("\n").find((l) => RESOLVED.test(l)) ?? "", 100)}" ([comment](${hint.html_url}))`;
    note(short(i), i.html_url, i.title, t);
  }
  for (const c of mine.filter((c) => c.blocker)) {
    const e = blocked.get(c.ref);
    note(c.ref, c.issueUrl, e?.title ?? "", `${c.blocker} ([comment](${c.url}))`);
  }
  const blk = [...blocked].map(([ref, e]) =>
    `- [${ref}](${e.url})${e.title ? " " + e.title : ""}\n` + e.notes.map((n) => `  - ${n}`).join("\n"));
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
