// Shared rules for setting "ITAC Jira Responsible" from an issue's first assignee.
// Used by notify-project-item.mjs when an item's first assignee changes or the field is empty.
//
// Configuration (set on the notification step in the workflow):
//   RESPONSIBLE_MAP     JSON object: GitHub login -> option name of the single-select field
//   RESPONSIBLE_LABELS  JSON array: only issues with at least one of these labels are assigned
// Logins and labels match case-insensitively.

// GraphQL selection for the parts of an Issue/PullRequest the rules need.
export const RESPONSIBLE_CONTENT_FIELDS = `assignees(first: 1) { nodes { login } } labels(first: 50) { nodes { name } }`;

export function parseResponsibleMap(raw) {
  if (!raw || !raw.trim()) return {};
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error(`RESPONSIBLE_MAP is not valid JSON: ${e.message}`); }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("RESPONSIBLE_MAP must be a JSON object.");
  return Object.fromEntries(Object.entries(obj).map(([login, value]) => [login.toLowerCase(), String(value)]));
}

export function parseResponsibleLabels(raw) {
  if (!raw || !raw.trim()) return new Set();
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error(`RESPONSIBLE_LABELS is not valid JSON: ${e.message}`); }
  if (!Array.isArray(arr)) throw new Error("RESPONSIBLE_LABELS must be a JSON array of label names.");
  return new Set(arr.map(l => String(l).trim().toLowerCase()));
}

// Reads both settings from the environment. Returns null when either is empty (feature off).
export function loadResponsibleConfig(env = process.env) {
  const map = parseResponsibleMap(env.RESPONSIBLE_MAP);
  const labels = parseResponsibleLabels(env.RESPONSIBLE_LABELS);
  if (!Object.keys(map).length || !labels.size) return null;
  return { map, labels };
}

// Resolves each mapped value to an option of the single-select field.
// Returns { optionByLogin, missing } where missing lists values with no matching option.
export function resolveResponsibleOptions(options, map) {
  const optionByLogin = {};
  const missing = [];
  for (const [login, value] of Object.entries(map)) {
    const opt = options.find(o => o.name.trim().toLowerCase() === value.trim().toLowerCase());
    if (opt) optionByLogin[login] = opt;
    else missing.push({ login, value });
  }
  return { optionByLogin, missing };
}

export function firstAssignee(content) {
  return content?.assignees?.nodes?.[0]?.login ?? "";
}

// The option an item should have, or null when the rules don't apply
// (no eligible label, no assignee, or an assignee who isn't mapped).
export function desiredResponsible(content, labels, optionByLogin) {
  const itemLabels = content?.labels?.nodes ?? [];
  if (!itemLabels.some(l => labels.has(l.name.trim().toLowerCase()))) return null;
  const login = firstAssignee(content);
  if (!login) return null;
  const option = optionByLogin[login.toLowerCase()];
  return option ? { login, option } : null;
}
