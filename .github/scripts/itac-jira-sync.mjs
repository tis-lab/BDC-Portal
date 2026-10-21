// Normalizes "ITAC Jira ID", sets "ITAC Jira URL", and marks "ITAC Jira" Yes/Error
// on items of an org-level GitHub Project (v2).
import { appendFileSync } from "node:fs";

const TOKEN = process.env.PROJECT_TOKEN;
const ORG = process.env.ORG || "tis-lab";
const PROJECT_NUMBER = parseInt(process.env.PROJECT_NUMBER ?? "", 10);
const ITEM_ID = (process.env.ITEM_ID || "").trim();
const DRY_RUN = process.env.DRY_RUN === "true";

const FIELD_ID = "ITAC Jira ID";
const FIELD_URL = "ITAC Jira URL";
const FIELD_STATUS = "ITAC Jira";
const URL_BASE = "https://itacjira.nhlbi.nih.gov/projects/BDCP/browse/";
const CANONICAL = /^BDCP-\d+$/;
const STATUS_OK = "Yes";
const STATUS_ERR = "Error";


// ---------- GraphQL ----------
async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL error (${res.status}): ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

const FIELD_VALUES = `
  fieldValues(first: 50) {
    nodes {
      ... on ProjectV2ItemFieldTextValue {
        text
        field { ... on ProjectV2FieldCommon { id } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        optionId
        field { ... on ProjectV2FieldCommon { id } }
      }
    }
  }`;

async function loadProject() {
  const data = await gql(
    `query($org: String!, $num: Int!) {
      organization(login: $org) {
        projectV2(number: $num) {
          id
          title
          fields(first: 100) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
            }
          }
        }
      }
    }`,
    { org: ORG, num: PROJECT_NUMBER }
  );
  const project = data.organization?.projectV2;
  if (!project) fail(`Project #${PROJECT_NUMBER} not found in org ${ORG} (or token lacks access).`);

  const byName = Object.fromEntries(project.fields.nodes.filter(f => f?.name).map(f => [f.name, f]));
  const fields = { id: byName[FIELD_ID], url: byName[FIELD_URL], status: byName[FIELD_STATUS] };
  for (const [key, name] of [["id", FIELD_ID], ["url", FIELD_URL], ["status", FIELD_STATUS]]) {
    if (!fields[key]) fail(`Field "${name}" not found on project "${project.title}".`);
  }
  if (fields.id.dataType !== "TEXT") fail(`"${FIELD_ID}" must be a Text field (is ${fields.id.dataType}).`);
  if (fields.url.dataType !== "TEXT") fail(`"${FIELD_URL}" must be a Text field (is ${fields.url.dataType}).`);

  if (fields.status.dataType === "SINGLE_SELECT") {
    const find = n => fields.status.options.find(o => o.name.toLowerCase() === n.toLowerCase());
    fields.status.okOption = find(STATUS_OK);
    fields.status.errOption = find(STATUS_ERR);
    if (!fields.status.okOption || !fields.status.errOption) {
      fail(`Single-select "${FIELD_STATUS}" needs options "${STATUS_OK}" and "${STATUS_ERR}". ` +
           `Found: ${fields.status.options.map(o => o.name).join(", ")}`);
    }
  } else if (fields.status.dataType !== "TEXT") {
    fail(`"${FIELD_STATUS}" must be Single select or Text (is ${fields.status.dataType}).`);
  }
  return { project, fields };
}

async function* allItems(projectNumber) {
  let after = null;
  do {
    const data = await gql(
      `query($org: String!, $num: Int!, $after: String) {
        organization(login: $org) {
          projectV2(number: $num) {
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id ${FIELD_VALUES} }
            }
          }
        }
      }`,
      { org: ORG, num: projectNumber, after }
    );
    const page = data.organization.projectV2.items;
    for (const item of page.nodes) yield item;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}

async function oneItem(itemId, projectId) {
  const data = await gql(
    `query($id: ID!) { node(id: $id) { ... on ProjectV2Item { id project { id } ${FIELD_VALUES} } } }`,
    { id: itemId }
  );
  const item = data.node;
  if (!item?.project) fail(`Item ${itemId} not found or is not a ProjectV2Item.`);
  if (item.project.id !== projectId) fail(`Item ${itemId} belongs to a different project.`);
  return item;
}

async function setText(projectId, itemId, fieldId, text) {
  if (DRY_RUN) return;
  await gql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $t: String!) {
      updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: {text: $t}}) {
        projectV2Item { id }
      }
    }`,
    { p: projectId, i: itemId, f: fieldId, t: text }
  );
}

async function setOption(projectId, itemId, fieldId, optionId) {
  if (DRY_RUN) return;
  await gql(
    `mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) {
      updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: {singleSelectOptionId: $o}}) {
        projectV2Item { id }
      }
    }`,
    { p: projectId, i: itemId, f: fieldId, o: optionId }
  );
}

// ---------- Logic ----------
export function normalize(raw) {
  const v = raw.trim();
  if (CANONICAL.test(v)) return { ok: true, value: v };
  const runs = v.match(/\d+/g) ?? [];
  if (runs.length === 1) return { ok: true, value: `BDCP-${runs[0]}` };
  return {
    ok: false,
    reason: runs.length === 0 ? "no digits found" : `ambiguous: ${runs.length} separate numbers (${runs.join(", ")})`,
  };
}

function valuesByField(item) {
  const out = {};
  for (const v of item.fieldValues.nodes) if (v?.field?.id) out[v.field.id] = v;
  return out;
}

async function processItem(project, fields, item, stats) {
  const vals = valuesByField(item);
  const raw = vals[fields.id.id]?.text ?? "";
  if (!raw.trim()) { stats.skipped++; return; }

  const currentUrl = vals[fields.url.id]?.text ?? "";
  const statusVal = vals[fields.status.id];
  const currentStatus = fields.status.dataType === "SINGLE_SELECT" ? statusVal?.optionId : statusVal?.text;

  let idOk = false, urlOk = false, canonical = null;
  const notes = [];

  // Step 1: validate / normalize the ID
  const n = normalize(raw);
  if (n.ok) {
    canonical = n.value;
    try {
      if (raw !== canonical) {
        await setText(project.id, item.id, fields.id.id, canonical);
        notes.push(`ID "${raw}" -> "${canonical}"`);
      }
      idOk = true;
    } catch (e) {
      notes.push(`ID update failed: ${e.message}`);
      stats.apiErrors++;
    }
  } else {
    notes.push(`ID "${raw}" invalid: ${n.reason}`);
  }

  // Step 2: URL (only possible with a valid ID)
  if (idOk) {
    const url = URL_BASE + canonical;
    try {
      if (currentUrl !== url) {
        await setText(project.id, item.id, fields.url.id, url);
        notes.push(`URL set`);
      }
      urlOk = true;
    } catch (e) {
      notes.push(`URL update failed: ${e.message}`);
      stats.apiErrors++;
    }
  }

  // Step 3: status
  const success = idOk && urlOk;
  const desiredLabel = success ? STATUS_OK : STATUS_ERR;
  const desired = fields.status.dataType === "SINGLE_SELECT"
    ? (success ? fields.status.okOption.id : fields.status.errOption.id)
    : desiredLabel;
  try {
    if (currentStatus !== desired) {
      if (fields.status.dataType === "SINGLE_SELECT") await setOption(project.id, item.id, fields.status.id, desired);
      else await setText(project.id, item.id, fields.status.id, desired);
      notes.push(`status -> ${desiredLabel}`);
    }
  } catch (e) {
    notes.push(`status update failed: ${e.message}`);
    stats.apiErrors++;
  }

  if (success) stats.ok++; else stats.error++;
  if (notes.length) {
    stats.changed++;
    const line = `${item.id}: ${notes.join("; ")}`;
    console.log((DRY_RUN ? "[dry-run] " : "") + line);
    stats.log.push(line);
  }
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// ---------- Main ----------
async function main() {
  if (!TOKEN) fail("PROJECT_TOKEN is not set.");
  if (!Number.isInteger(PROJECT_NUMBER)) fail("PROJECT_NUMBER repo variable is not set or not a number.");
  const { project, fields } = await loadProject();
  console.log(`Project: ${project.title} (#${PROJECT_NUMBER})${DRY_RUN ? " [DRY RUN]" : ""}`);
  const stats = { ok: 0, error: 0, skipped: 0, changed: 0, apiErrors: 0, log: [] };

  if (ITEM_ID) {
    await processItem(project, fields, await oneItem(ITEM_ID, project.id), stats);
  } else {
    for await (const item of allItems(PROJECT_NUMBER)) await processItem(project, fields, item, stats);
  }

  const summary =
    `### ITAC Jira sync${DRY_RUN ? " (dry run)" : ""}\n\n` +
    `Valid: ${stats.ok} · Error: ${stats.error} · Empty/skipped: ${stats.skipped} · ` +
    `Items changed: ${stats.changed} · API failures: ${stats.apiErrors}\n\n` +
    (stats.log.length ? "```\n" + stats.log.join("\n") + "\n```\n" : "");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);

  // Bad data is reported via the "Error" status; only API failures fail the run.
  if (stats.apiErrors > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => fail(e.stack || e.message));
}
