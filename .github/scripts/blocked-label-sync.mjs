// Keeps the `Blocked` label in step with the board Status, and alerts Slack when an issue becomes blocked.
//   Status = Blocked, no label   -> add the label and post to Slack
//   Status set and not Blocked, has label -> remove the label
// Only open issues in REPOS that are on the project board are touched. If Status is empty, nothing changes.
const {
  GH_TOKEN, PROJECT_TOKEN, REPOS, SLACK_WEBHOOK_URL = "",
  ORG = "tis-lab", PROJECT_NUMBER = "7", DRY_RUN = "false",
} = process.env;
const LABEL = "Blocked";
const dry = DRY_RUN === "true";
const repos = new Set(REPOS.split(/\s+/).filter(Boolean).map((r) => r.toLowerCase()));
if (!PROJECT_TOKEN) throw new Error("PROJECT_TOKEN is required to read the project board");

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${PROJECT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`GraphQL error (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}
async function rest(method, path, body) {
  const data = await restJson(method, path, body);
  return data;
}
async function restJson(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

// Most recent comment (last 14 days) that says what the blocker is: a line starting "Blocker:",
// or a line containing the word "blocked" (unless it says the blocker is resolved).
const RESOLVED = /\b(unblocked|no longer blocked|not blocked|isn'?t blocked|resolved|addressed)\b/i;
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function blockerComment(repo, number) {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const comments = (await restJson("GET", `/repos/${repo}/issues/${number}/comments?since=${since}&per_page=100`)) ?? [];
  for (const c of comments.reverse()) {
    const lines = c.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const text = c.body.match(/^[ \t>*_-]*blockers?\**\s*:\s*(.+)$/im)?.[1] ??
      lines.find((l) => /\bblocked\b/i.test(l) && !RESOLVED.test(l));
    if (text) return { text: text.trim().slice(0, 300), url: c.html_url, user: c.user.login };
  }
  return null;
}

const items = [];
for (let after = null, more = true; more;) {
  const page = (await gql(
    `query($org:String!,$num:Int!,$after:String){organization(login:$org){projectV2(number:$num){
       items(first:100,after:$after){pageInfo{hasNextPage endCursor}
         nodes{status:fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}
               content{... on Issue{url number title state repository{nameWithOwner}
                 labels(first:50){nodes{name}} assignees(first:10){nodes{login}}}}}}}}}`,
    { org: ORG, num: Number(PROJECT_NUMBER), after })).organization.projectV2.items;
  items.push(...page.nodes);
  more = page.pageInfo.hasNextPage; after = page.pageInfo.endCursor;
}

const alerts = [];
for (const it of items) {
  const c = it.content;
  if (!c?.url || c.state !== "OPEN" || !repos.has(c.repository.nameWithOwner.toLowerCase())) continue;
  const status = it.status?.name ?? "";
  if (!status) continue;
  const repo = c.repository.nameWithOwner;
  const hasLabel = c.labels.nodes.some((l) => l.name.toLowerCase() === LABEL.toLowerCase());
  const blocked = status.toLowerCase() === "blocked";
  if (blocked && !hasLabel) {
    console.log(`${dry ? "[dry run] would add" : "add"} label: ${repo}#${c.number} (${c.title})`);
    if (!dry) await rest("POST", `/repos/${repo}/issues/${c.number}/labels`, { labels: [LABEL] });
    const why = await blockerComment(repo, c.number);
    console.log(why ? `  blocker comment by ${why.user}: ${why.text}` : "  no blocker comment found");
    alerts.push(`:rotating_light: *Blocked:* <${c.url}|${repo}#${c.number} ${esc(c.title)}>` +
      (c.assignees.nodes.length ? ` (${c.assignees.nodes.map((a) => "@" + a.login).join(", ")})` : "") +
      (why ? `\n> ${esc(why.text)} (<${why.url}|comment by ${why.user}>)`
           : `\n> _No blocker comment yet. Add a comment starting \`Blocker:\` saying what you are waiting on._`));
  } else if (!blocked && hasLabel) {
    console.log(`${dry ? "[dry run] would remove" : "remove"} label (Status is ${status}): ${repo}#${c.number}`);
    if (!dry) await rest("DELETE", `/repos/${repo}/issues/${c.number}/labels/${encodeURIComponent(LABEL)}`);
  }
}
console.log(`checked ${items.length} board items; ${alerts.length} newly blocked`);

if (alerts.length && !dry) {
  if (!SLACK_WEBHOOK_URL) console.log("SLACK_WEBHOOK_URL not set; skipping Slack");
  else {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alerts.join("\n") }),
    });
    console.log(`slack: ${res.status}`);
  }
}
