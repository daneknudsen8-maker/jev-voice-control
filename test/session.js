// Extract the most recent voice session from the trace and sort its commands
// into ones that worked, ones correctly refused, and ones that are real gaps.
//
//   node session.js              the most recent session
//   node session.js --all        every session
//   node session.js --n 2        the 2nd most recent
//   node session.js --json       machine-readable, for an agent to act on
//
// A session is a run of commands with no gap longer than SESSION_GAP.

import { readFile } from "node:fs/promises";

const TRACE = process.env.JEV_TRACE_FILE ?? "/tmp/jev-trace.jsonl";
const SESSION_GAP_MS = 15 * 60 * 1000;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const showAll = args.includes("--all");
const nth = args.includes("--n") ? Number(args[args.indexOf("--n") + 1]) : 1;

// Outcomes that are the system working as intended, not gaps.
const CORRECT_REFUSAL = new Set([
  "risk_gate", "danger_word", "close_other_tab", "user_confirmed", "user_cancelled",
]);

// Reason codes that mean the command did what was asked. Records written before
// the extension counted dictation writes as successes still carry these.
const SUCCESS_WHY = new Set([
  "ok", "ok_web_search", "ok_spoken_domain", "ok_guessed_domain", "local_command",
  "content", "control_phrase", "control_judged", "named_field", "named_field_only",
  "field_judged", "current_field", "open_composer_first", "named_tab", "named_element",
  "tab_navigation",
]);

// Why a command didn't run, and what kind of fix it points at.
const DIAGNOSIS = {
  not_a_command:     { cause: "dropped as conversation", fix: "If the words name something real on screen, strongNameMatch in commands.js should catch it. If it was genuine noise, this is correct." },
  action_none:       { cause: "no ACTIONS description covers this phrasing", fix: "Extend the relevant description in ACTIONS (extension/commands.js)." },
  action_unclear:    { cause: "two actions looked equally likely", fix: "Sharpen the competing ACTIONS descriptions so they exclude each other." },
  target_no_match:   { cause: "no element matched", fix: "CHECK THE CANDIDATE LIST. Absent → ranking in content.js. Present but unchosen → target question wording." },
  target_ambiguous:  { cause: "several elements looked alike", fix: "Often correct on repetitive pages. If wrong, improve element text in labelFor()." },
  field_unresolved:  { cause: "no writable field matched", fix: "Check the TYPEABLE selector list and fieldRole() in content.js." },
  no_dictation_text: { cause: "no text found after the verb", fix: "Extend DICTATION_LEAD in commands.js." },
  no_destination:    { cause: "not a known site, no query extractable", fix: "Add to KNOWN_SITES, or extend spokenDomain/guessDomain." },
  tab_no_match:      { cause: "no matching tab", fix: "If positional ('the other tab'), extend matchTabNavigation — position is arithmetic and belongs in code." },
  tab_ambiguous:     { cause: "tabs looked alike", fix: "If positional, it should never have reached the model. Extend matchTabNavigation." },
  no_page:           { cause: "needs a page, none open", fix: "Correct, unless the action genuinely works without a page." },
  page_unavailable:  { cause: "couldn't reach the page", fix: "Usually a stale content script or a restricted URL. Rarely a design gap." },
  exception:         { cause: "crashed", fix: "ALWAYS A BUG. Read the detail." },
  unknown:           { cause: "no reason code — traced before the extension recorded them", fix: "Historical. Ignore unless the same utterance still fails today." },
  no_field_to_compose: { cause: "nothing to write into", fix: "Should now open a composer itself via compose_via. If it didn't, check the target answer." },
  compose_tab_changed: { cause: "tab changed mid-message", fix: "Check activeTab() is not returning the panel's own window." },
  dictation_tab_changed: { cause: "tab changed mid-message", fix: "Same as above." },
};

let lines;
try {
  lines = (await readFile(TRACE, "utf8")).trim().split("\n").filter(Boolean);
} catch {
  console.error(`No trace at ${TRACE}. Start the proxy, run some voice commands, then try again.`);
  process.exit(1);
}

const outcomes = lines
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.kind === "outcome");

if (!outcomes.length) {
  console.error("No outcome records yet. Reload the extension, then run some commands.");
  process.exit(1);
}

// Split into sessions on time gaps.
const sessions = [];
let current = [];
let previous = null;
for (const r of outcomes) {
  const at = Date.parse(r.at ?? "") || 0;
  if (previous && at && previous && at - previous > SESSION_GAP_MS) {
    sessions.push(current);
    current = [];
  }
  current.push(r);
  if (at) previous = at;
}
if (current.length) sessions.push(current);

const chosen = showAll ? outcomes : (sessions[sessions.length - nth] ?? []);

/**
 * Speech that was dropped as conversation is only a GAP if the words actually
 * named something on screen. "Loom" with a Loom tab open is a gap; "xenobag"
 * is the microphone doing its job being ignored.
 */
function namedSomething(r) {
  const said = String(r.utterance ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (said.length < 3 || said.split(" ").length > 4) return false;
  const targets = [
    ...(r.candidates?.elements ?? []).map((e) => e.text),
    ...(r.candidates?.tabs ?? []).map((t) => `${t.title} ${t.host}`),
  ];
  return targets.some((t) => {
    const candidate = String(t ?? "").toLowerCase();
    return candidate.includes(said);
  });
}

function classify(r) {
  if (r.executed || SUCCESS_WHY.has(r.why)) return "worked";
  if (CORRECT_REFUSAL.has(r.why)) return "by_design";
  if (r.outcome === "confirm") return "by_design";
  // Noise the system was right to ignore.
  if (r.why === "not_a_command" && !namedSomething(r)) return "noise";
  return "gap";
}

const grouped = { worked: [], by_design: [], noise: [], gap: [] };
for (const r of chosen) grouped[classify(r)].push(r);

// Repeated failures matter more than one-offs.
const byReason = {};
for (const r of grouped.gap) {
  const key = r.why ?? "unknown";
  (byReason[key] ??= []).push(r);
}

if (asJson) {
  console.log(JSON.stringify({
    sessions: sessions.length,
    analyzed: chosen.length,
    worked: grouped.worked.length,
    by_design: grouped.by_design.length,
    noise_correctly_ignored: grouped.noise.length,
    gaps: grouped.gap.length,
    noise_samples: grouped.noise.slice(0, 8).map((r) => r.utterance),
    reasons: Object.fromEntries(Object.entries(byReason).map(([why, rs]) => [why, {
      count: rs.length,
      diagnosis: DIAGNOSIS[why] ?? { cause: "unknown", fix: "Inspect the records." },
      utterances: rs.map((r) => ({
        said: r.utterance, detail: r.detail, page: r.page?.title,
        answers: r.answers ? Object.fromEntries(Object.entries(r.answers).map(([id, a]) => [
          id, a.type === "noul" ? a.noul : a.type === "choice" ? { choice: a.choice, confidence: a.confidence }
            : { score: a.score, confidence: a.confidence },
        ])) : null,
        candidates: r.candidates?.elements?.map((e) => `${e.id} ${e.kind}: ${e.text}`) ?? null,
        tabs: r.candidates?.tabs?.map((t) => `${t.id} ${t.title}`) ?? null,
      })),
    }])),
  }, null, 2));
} else {

const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", X = "\x1b[0m";
const when = (r) => (r.at ? new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

console.log(`\n${B}Session ${sessions.length - nth + 1} of ${sessions.length}${X}  ·  ${chosen.length} commands`);
if (chosen.length) console.log(`${D}${when(chosen[0])} – ${when(chosen[chosen.length - 1])}${X}`);
console.log(`\n${G}${grouped.worked.length} worked${X} · ${D}${grouped.by_design.length} refused by design${X} · ${D}${grouped.noise.length} noise ignored${X} · ${grouped.gap.length ? R : G}${grouped.gap.length} gaps${X}\n`);

if (grouped.noise.length) {
  console.log(`${D}Ignored as noise (nothing on screen matched): ${grouped.noise.slice(0, 8).map((r) => `"${r.utterance}"`).join(", ")}${grouped.noise.length > 8 ? ` +${grouped.noise.length - 8} more` : ""}${X}\n`);
}

if (!grouped.gap.length) {
  console.log(`${G}Nothing to fix in this session.${X}\n`);
}

console.log(`${B}GAPS, most repeated first${X}\n`);
for (const [why, records] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
  const d = DIAGNOSIS[why] ?? DIAGNOSIS.unknown;
  console.log(`${B}${why}${X} ${D}×${records.length}${X} — ${d.cause}`);
  console.log(`  ${Y}${d.fix}${X}`);
  for (const r of records) {
    console.log(`\n  ${B}"${r.utterance}"${X}  ${D}${when(r)} · ${r.page?.title ?? "?"}${X}`);
    if (r.detail) console.log(`    ${D}${r.detail}${X}`);
    const a = r.answers ?? {};
    const bits = Object.entries(a).map(([id, v]) =>
      v.type === "noul" ? `${id}=${v.noul.toFixed(2)}`
      : v.type === "choice" ? `${id}=${v.choice}@${v.confidence.toFixed(2)}`
      : `${id}=${v.score.toFixed(2)}@${v.confidence.toFixed(2)}`);
    if (bits.length) console.log(`    ${D}${bits.join("  ")}${X}`);

    // The decisive evidence for a missed click.
    const els = r.candidates?.elements ?? [];
    if (why === "target_no_match" && els.length) {
      console.log(`    ${D}candidates (${els.length}):${X}`);
      for (const e of els.slice(0, 20)) console.log(`      ${D}${e.id} ${e.kind}: "${e.text}"${X}`);
      if (els.length > 20) console.log(`      ${D}… ${els.length - 20} more${X}`);
    }
    const tabs = r.candidates?.tabs ?? [];
    if ((why === "tab_no_match" || why === "tab_ambiguous") && tabs.length) {
      console.log(`    ${D}open tabs: ${tabs.map((t) => `"${t.title}"`).join(", ")}${X}`);
    }
  }
  console.log();
}

  console.log(`${D}Full detail: node session.js --json${X}\n`);
}
