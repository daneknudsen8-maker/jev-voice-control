// Field routing while writing an email. The first block replays the exact
// session from the trace, where every utterance landed in the body.
//
//   node --env-file=../.env compose-harness.js

import { buildComposeQuestions, REPLACES, resolveCompose, spokenEmail } from "../extension/compose.js";
import { appendChunk } from "../extension/dictation.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const AVAILABLE = ["to", "cc", "bcc", "subject", "body"];
const questions = buildComposeQuestions(AVAILABLE);

// Each script is a conversation: field state carries from one line to the next.
const SCRIPTS = [
  {
    name: "the real session from the trace",
    lines: [
      { say: "to",                          field: "to",      writes: false },
      { say: "Sarah Chen",                  field: "to",      writes: true },
      { say: "subject line should be",      field: "subject", writes: false },
      { say: "new tool",                    field: "subject", writes: true },
      { say: "the body should say hi Sarah, I wanted to show you what we built", field: "body", writes: true },
    ],
  },
  {
    name: "all in one breath",
    lines: [
      { say: "send it to marco at example dot com", field: "to",      writes: true },
      { say: "cc Anna",                             field: "cc",      writes: true },
      { say: "the subject should be quarterly review", field: "subject", writes: true },
      { say: "the main body of the email should say let's meet on Thursday", field: "body", writes: true },
    ],
  },
  {
    name: "body keeps going once started",
    lines: [
      { say: "the subject is lunch",        field: "subject", writes: true },
      { say: "the body should say hi there", field: "body",   writes: true },
      { say: "are you free on Thursday",    field: "body",    writes: true },
      { say: "let me know what works",      field: "body",    writes: true },
    ],
  },
  {
    // Every line here is verbatim from a session where it went wrong.
    name: "regressions from a real session",
    lines: [
      // wrote its own words into the To field
      { say: "let's send it to",             field: "to",   writes: false },
      { say: "Zeno",                         field: "to",   writes: true },
      // a browser command that landed in the To field
      { say: "yeah click on the second one down", control: "other_command" },
      { say: "the subject should be",        field: "subject", writes: false },
      { say: "hello",                        field: "subject", writes: true },
      { say: "and the body of the email should say", field: "body", writes: false },
      { say: "what's up",                    field: "body", writes: true },
    ],
  },
  {
    name: "controls still work",
    lines: [
      { say: "to Jane",                     field: "to",      writes: true },
      { say: "scratch that",                control: "undo" },
      { say: "stop dictating",              control: "finish" },
    ],
  },
];

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let pass = 0, total = 0; const failures = [];

for (const script of SCRIPTS) {
  console.log(`\n\x1b[1m${script.name}\x1b[0m`);
  console.log(pad("said", 52), pad("→ field", 10), pad("wrote", 30), "ok");
  console.log("-".repeat(102));

  let current = "to";
  const text = {};

  for (const line of script.lines) {
    total++;
    // Same short-circuit the extension uses.
    let decision = resolveCompose(null, line.say, current);
    let answers = null;
    if (!["control_phrase", "named_field", "named_field_only"].includes(decision.why)) {
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          state: { utterance: line.say, current_field: current, message_so_far: text },
          model: "jev-latest", questions,
        }),
      });
      if (!res.ok) { console.log(pad(line.say, 52), `ERROR ${res.status}`); continue; }
      answers = (await res.json()).answers;
      decision = resolveCompose(answers, line.say, current);
    }

    let ok, shown;
    if (line.control) {
      ok = decision.do === line.control;
      shown = `control: ${decision.do}`;
      // A browser command must not disturb which field is being filled.
    } else {
      const wrote = decision.do === "write";
      if (decision.role) current = decision.role;
      if (wrote) {
        text[decision.role] = REPLACES.has(decision.role)
          ? spokenEmail(decision.text)
          : appendChunk(text[decision.role] ?? "", decision.text);
      }
      ok = decision.role === line.field && wrote === line.writes;
      shown = wrote ? `${decision.role}="${text[decision.role]}"` : `(switch to ${decision.role})`;
    }

    ok ? pass++ : failures.push([script.name, line.say, `expected ${line.control ?? `${line.field}/${line.writes ? "write" : "switch"}`}, got ${shown}`]);
    console.log(pad(line.say, 52), pad(decision.role ?? "—", 10), pad(shown, 30), ok ? "✓" : "✗");
  }

  if (Object.keys(text).length) {
    console.log("\n  resulting email:");
    for (const [role, value] of Object.entries(text)) console.log(`    ${pad(role + ":", 9)} ${value}`);
  }
}

console.log(`\n${pass}/${total} passed\n`);
for (const [script, say, why] of failures) console.log(`  [${script}] "${say}"\n      ${why}`);
process.exit(pass === total ? 0 : 1);
