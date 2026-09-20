// Every utterance, whether it executed, and which gate stopped it if not.
//
//   node report.js              the table
//   node report.js --why X      drill into one reason code
//   node report.js --failed     only what did not execute
//
// On a miss the decisive question is whether the right element was even in the
// candidate list. Absent → content.js ranking is at fault. Present but not
// chosen → the question wording is at fault. Opposite fixes, so --why prints
// the candidates.

import { readFile } from "node:fs/promises";

const TRACE = process.env.JEV_TRACE_FILE ?? "/tmp/jev-trace.jsonl";
const args = process.argv.slice(2);
const whyAt = args.indexOf("--why");
const drill = whyAt >= 0 ? args[whyAt + 1] : null;
const failedOnly = args.includes("--failed");

const G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

// What each reason code means, and what to change.
const EXPLAIN = {
  ok:                 ["ran normally", null],
  ok_web_search:      ["ran as a web search (site not in KNOWN_SITES)", "add it to KNOWN_SITES in extension/commands.js"],
  local_command:      ["matched a local phrase, never hit the model", null],
  not_a_command:      ["dropped: is_command below 0.5", "speech was read as conversation. Lower IS_COMMAND_FLOOR, or reword the is_command criteria"],
  action_none:        ["Jev read it as not a browser action", "the phrasing isn't covered by any ACTIONS description"],
  action_unclear:     ["action confidence below floor", "two actions looked equally likely — sharpen their descriptions in ACTIONS"],
  target_no_match:    ["Jev saw no matching element", "check candidates below: if the element is missing, fix ranking in content.js"],
  target_ambiguous:   ["several elements looked alike", "expected on repetitive pages; raise/lower FLOORS.target or improve element text"],
  field_unresolved:   ["no field matched", "the input may not be in the TYPEABLE selector list"],
  no_dictation_text:  ["no text found after the verb", "DICTATION_LEAD regex didn't match your phrasing"],
  no_destination:     ["not a known site, no query extractable", "add to KNOWN_SITES or reword"],
  tab_no_match:       ["no matching tab", null],
  tab_ambiguous:      ["several tabs looked alike", null],
  risk_gate:          ["stopped to confirm: risk >= 1.6", "lower CONFIRM_RISK if it nags too much"],
  danger_word:        ["stopped to confirm: target matched DANGER pattern", "edit the DANGER regex in commands.js"],
  close_tab_policy:   ["tab closes always confirm", "policy in code — change in resolveCommand"],
  user_confirmed:     ["you approved it", null],
  user_cancelled:     ["you declined it", null],
  page_unavailable:   ["couldn't reach the page", "usually a stale content script — reload the tab, or the extension if the manifest changed"],
  no_page:            ["command needs a page, none open", "navigate somewhere first"],
  exception:          ["crashed", "see detail"],
};

let lines;
try {
  lines = (await readFile(TRACE, "utf8")).trim().split("\n").filter(Boolean);
} catch {
  console.error(`No trace at ${TRACE}. Start the proxy, then run some commands.`);
  process.exit(1);
}

const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const outcomes = records.filter((r) => r.kind === "outcome");

if (!outcomes.length) {
  console.log(`\n${records.length} API calls traced, but no outcome records yet.`);
  console.log(`Reload the extension at chrome://extensions so it picks up the new reporting code.\n`);
  process.exit(0);
}

if (drill) {
  const hits = outcomes.filter((o) => o.why === drill);
  console.log(`\n${B}${hits.length} command(s) with reason "${drill}"${X}`);
  const [meaning, fix] = EXPLAIN[drill] ?? ["", null];
  if (meaning) console.log(`${D}${meaning}${X}`);
  if (fix) console.log(`${Y}fix: ${fix}${X}`);

  for (const o of hits) {
    console.log(`\n${B}▸ "${o.utterance}"${X}`);
    console.log(`  ${o.page?.title ?? "?"}  ·  ${o.detail ?? ""}`);
    if (o.answers) {
      for (const [id, a] of Object.entries(o.answers)) {
        if (a.type === "noul") console.log(`    ${id.padEnd(18)} ${a.noul.toFixed(2)}`);
        else if (a.type === "choice") console.log(`    ${id.padEnd(18)} ${String(a.choice).padEnd(12)} conf ${a.confidence.toFixed(2)}`);
        else if (a.type === "score") console.log(`    ${id.padEnd(18)} ${a.score.toFixed(2)}         conf ${a.confidence.toFixed(2)}`);
      }
    }
    const els = o.candidates?.elements ?? [];
    if (els.length) {
      console.log(`  ${D}candidates Jev could choose from (${els.length}):${X}`);
      for (const e of els.slice(0, 25)) console.log(`    ${D}${e.id.padEnd(5)} ${e.kind?.padEnd(14) ?? ""} "${e.text}"${X}`);
      if (els.length > 25) console.log(`    ${D}… ${els.length - 25} more${X}`);
    }
  }
  console.log();
  process.exit(0);
}

const shown = failedOnly ? outcomes.filter((o) => !o.executed) : outcomes;

console.log(`\n${B}${outcomes.length} commands traced${X}\n`);
console.log(`${B}${"ran".padEnd(4)}${"utterance".padEnd(44)}${"outcome".padEnd(12)}${"why".padEnd(20)}detail${X}`);
console.log("─".repeat(128));

for (const o of shown) {
  const mark = o.executed ? `${G}✓${X}  ` : (o.outcome === "error" ? `${R}✗${X}  ` : `${Y}·${X}  `);
  const line = [
    String(o.utterance ?? "").slice(0, 43).padEnd(44),
    String(o.outcome ?? "").padEnd(12),
    String(o.why ?? "").padEnd(20),
    String(o.detail ?? "").slice(0, 46),
  ].join("");
  console.log(mark + (o.executed ? line : `${D}${line}${X}`));
}

const ran = outcomes.filter((o) => o.executed).length;
console.log("─".repeat(128));
console.log(`\n${G}${ran} executed${X} · ${Y}${outcomes.length - ran} did not${X}\n`);

const byWhy = {};
for (const o of outcomes.filter((x) => !x.executed)) byWhy[o.why ?? "unknown"] = (byWhy[o.why ?? "unknown"] ?? 0) + 1;

if (Object.keys(byWhy).length) {
  console.log(`${B}why commands did not run${X}`);
  for (const [why, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) {
    const [meaning, fix] = EXPLAIN[why] ?? ["", null];
    console.log(`  ${String(n).padStart(3)}×  ${why.padEnd(20)} ${D}${meaning}${X}`);
    if (fix) console.log(`       ${Y}→ ${fix}${X}`);
    console.log(`       ${D}node report.js --why ${why}${X}`);
  }
  console.log();
}
