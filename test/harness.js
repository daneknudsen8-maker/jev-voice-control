// Exercises the real question design against the real model, with no browser.
//
//   node --env-file=../.env harness.js
//
// Each case is one API call. Prints a table of what Jev decided and whether the
// resolver produced the expected command.

import { buildCommandQuestions, matchLocalCommand, resolveCommand } from "../extension/commands.js";
import { ELEMENTS, TYPEABLES, TABS, PAGE, CASES, BLANK_TAB_CASES } from "./fixtures.js";

const API_KEY = process.env.TYPESAFE_API_KEY;
const API_URL = `${process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone`;
if (!API_KEY) { console.error("TYPESAFE_API_KEY not set — run with node --env-file=../.env harness.js"); process.exit(1); }

const blank = process.argv.includes("--blank");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
const source = blank ? BLANK_TAB_CASES : CASES;
const cases = only ? source.filter((c) => c.say.includes(only)) : source;

const elements  = blank ? [] : ELEMENTS;
const typeables = blank ? [] : TYPEABLES;
const page      = blank ? { title: "New tab", url: "", host: "" } : PAGE;

const questions = buildCommandQuestions({ elements, tabs: TABS, typeables });

async function ask(utterance) {
  const body = {
    state: { utterance, page, elements, typeables, open_tabs: TABS },
    model: "jev-latest",
    questions,
  };
  const started = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { answers: json.answers, usage: json.usage, ms: Date.now() - started };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let pass = 0, fail = 0, tokens = 0, totalMs = 0;
const failures = [];

console.log(`\n${cases.length} utterances · ${Object.keys(questions).length} questions per request · jev-latest${blank ? " · BLANK TAB (no page)" : ""}\n`);
console.log(pad("utterance", 42), pad("action", 12), pad("conf", 6), pad("cmd", 6), pad("risk", 6), pad("resolved", 26), "ok");
console.log("-".repeat(112));

for (const testCase of cases) {
  // Same code path the extension takes: local commands skip the model entirely.
  const local = matchLocalCommand(testCase.say);
  if (local) {
    const ok = testCase.expect === "stop";
    console.log(pad(testCase.say, 42), pad("(local)", 12), pad("—", 6), pad("—", 6), pad("—", 6), pad("stop", 26), ok ? "✓" : "✗");
    ok ? pass++ : (fail++, failures.push([testCase.say, `local match, expected ${testCase.expect}`]));
    continue;
  }

  let answers, usage, ms;
  try {
    ({ answers, usage, ms } = await ask(testCase.say));
  } catch (error) {
    console.log(pad(testCase.say, 42), `ERROR ${error.message}`);
    fail++; failures.push([testCase.say, error.message]);
    continue;
  }
  tokens += usage.input_tokens;
  totalMs += ms;

  const decision = resolveCommand(answers, {
    transcript: testCase.say, elements, typeables, tabs: TABS, readable: !blank,
  });

  // What did the resolver actually produce?
  const cmd = decision.command;
  let resolved, actual;
  if (decision.kind === "ask_page")       { resolved = "ask_page"; actual = "ask_page"; }
  else if (decision.kind === "ignore")    { resolved = `ignore`; actual = "none"; }
  else if (decision.kind === "clarify")   { resolved = `clarify`; actual = "clarify"; }
  else if (decision.kind === "choose")    { resolved = `choose(${decision.options.length})`; actual = "choose"; }
  else if (cmd?.do === "history")         { resolved = cmd.delta < 0 ? "back" : "forward"; actual = resolved; }
  else if (cmd?.do === "stop_listening")  { resolved = "stop"; actual = "stop"; }
  else if (cmd?.do === "scroll")          { resolved = `scroll ${cmd.direction}`; actual = "scroll"; }
  else if (cmd?.do === "navigate")        { resolved = `navigate ${new URL(cmd.url).host}`; actual = "navigate"; }
  else if (cmd?.do === "click")           { resolved = `click ${cmd.id}`; actual = "click"; }
  else if (cmd?.do === "type")            { resolved = `type→${cmd.id} "${cmd.text}"`.slice(0, 26); actual = "type"; }
  else if (cmd?.do === "switch_tab")      { resolved = `switch ${cmd.id}`; actual = "switch_tab"; }
  else if (cmd?.do === "close_tab")       { resolved = `close ${cmd.id}`; actual = "close_tab"; }
  else if (cmd?.do)                       { resolved = cmd.do; actual = cmd.do; }
  else                                    { resolved = decision.kind; actual = decision.kind; }

  // Did we get the intent right, and the target when one was specified?
  let ok = actual === testCase.expect;
  if (ok && testCase.target) ok = (cmd?.id === testCase.target);
  if (ok && testCase.url) ok = (cmd?.url === testCase.url);
  if (ok && testCase.search) ok = Boolean(cmd?.url?.includes("google.com/search"));
  if (testCase.risky && decision.kind !== "confirm") ok = false;
  const confirmMark = decision.kind === "confirm" ? "🔒" : "";

  const a = answers.action;
  console.log(
    pad(testCase.say, 42),
    pad(a.choice, 12),
    pad(a.confidence.toFixed(2), 6),
    pad(answers.is_command.noul.toFixed(2), 6),
    pad(answers.risk.score.toFixed(2), 6),
    pad(resolved + confirmMark, 26),
    ok ? "✓" : "✗",
  );

  if (ok) pass++;
  else { fail++; failures.push([testCase.say, `expected ${testCase.expect}${testCase.target ? "/" + testCase.target : ""}${testCase.risky ? " (confirm)" : ""}, got ${resolved}`]); }
}

console.log("-".repeat(112));
console.log(`\n${pass}/${pass + fail} passed · ${tokens} input tokens total · ${Math.round(totalMs / cases.length)}ms avg`);
console.log(`cost: $${((tokens / 1e9) * 42).toFixed(6)} for this run\n`);

if (failures.length) {
  console.log("failures:");
  for (const [say, why] of failures) console.log(`  "${say}"\n      ${why}`);
  console.log();
}
process.exit(fail ? 1 : 0);
