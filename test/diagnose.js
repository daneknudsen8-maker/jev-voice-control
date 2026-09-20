// Reads the proxy trace and flags decisions that look wrong, so a failed
// command can be diagnosed after the fact.
//
//   node diagnose.js                 all traced calls
//   node diagnose.js --bad           only suspicious ones
//   node diagnose.js --utterance X   just calls matching X
//
// The key question for any miss: was the right element even IN the candidate
// list? If it was absent, the ranking in content.js is at fault. If it was
// present and Jev chose another, the wording is at fault. Opposite fixes.

import { readFile } from "node:fs/promises";

const TRACE = process.env.JEV_TRACE_FILE ?? "/tmp/jev-trace.jsonl";
const args = process.argv.slice(2);
const onlyBad = args.includes("--bad");
const filterAt = args.indexOf("--utterance");
const filter = filterAt >= 0 ? args[filterAt + 1]?.toLowerCase() : null;

let lines;
try {
  lines = (await readFile(TRACE, "utf8")).trim().split("\n").filter(Boolean);
} catch {
  console.error(`No trace at ${TRACE}. Start the proxy and run some commands first.`);
  process.exit(1);
}

const FLOORS = { action: 0.45, target: 0.40, field: 0.40 };

let shown = 0;
for (const line of lines) {
  let t;
  try { t = JSON.parse(line); } catch { continue; }
  if (filter && !t.utterance.toLowerCase().includes(filter)) continue;

  const a = t.answers ?? {};
  const problems = [];

  if (a.is_command && a.is_command.noul < 0.5) problems.push(`DROPPED as non-command (${a.is_command.noul.toFixed(2)})`);
  if (a.action && a.action.confidence < FLOORS.action) problems.push(`action unclear (${a.action.confidence.toFixed(2)})`);
  if (a.action?.choice === "click" && a.target?.choice === "no_match") problems.push("click with NO matching element");
  if (a.action?.choice === "click" && a.target && a.target.choice !== "no_match" && a.target.confidence < FLOORS.target) problems.push(`target ambiguous (${a.target.confidence.toFixed(2)})`);
  if (a.action?.choice === "type" && a.field?.choice === "no_match") problems.push("type with NO matching field");
  if (a.risk && a.risk.score >= 1.6) problems.push(`risk gate fired (${a.risk.score.toFixed(2)})`);
  if (t.tokens > 8000) problems.push(`large state (${t.tokens} tok, ${t.elements.length} elements)`);
  if (a.answered && a.answered.noul < 0.45) problems.push(`page did not answer (${a.answered.noul.toFixed(2)})`);

  if (onlyBad && !problems.length) continue;
  shown++;

  console.log(`\n▸ "${t.utterance}"`);
  console.log(`  ${t.page?.title ?? "?"} · ${t.ms}ms · ${t.tokens} tok · ${t.elements.length} elements, ${t.typeables.length} fields`);

  for (const [id, ans] of Object.entries(a)) {
    if (ans.type === "noul") console.log(`    ${id.padEnd(18)} ${ans.noul.toFixed(2)}`);
    else if (ans.type === "choice") console.log(`    ${id.padEnd(18)} ${String(ans.choice).padEnd(14)} conf ${ans.confidence.toFixed(2)}   ${runnersUp(ans)}`);
    else if (ans.type === "score") console.log(`    ${id.padEnd(18)} ${ans.score.toFixed(2)}          conf ${ans.confidence.toFixed(2)}`);
  }

  // Resolve element ids to their text, so "e37" means something.
  const byId = new Map([...t.elements, ...t.typeables].map((e) => [e.id, e]));
  for (const key of ["target", "field"]) {
    const ans = a[key];
    if (ans && byId.has(ans.choice)) {
      const el = byId.get(ans.choice);
      console.log(`    └ ${key} resolved to: "${el.text}" (${el.kind}, ${el.where})`);
    }
  }

  if (problems.length) console.log(`  ⚠ ${problems.join("  |  ")}`);
}

console.log(`\n${shown} of ${lines.length} traced calls shown.\n`);

function runnersUp(ans) {
  const rest = Object.entries(ans.probabilities ?? {})
    .filter(([k]) => k !== ans.choice)
    .sort((x, y) => y[1] - x[1])
    .filter(([, p]) => p > 0.03)
    .slice(0, 3)
    .map(([k, p]) => `${k} ${p.toFixed(2)}`);
  return rest.length ? `(also ${rest.join(", ")})` : "";
}
