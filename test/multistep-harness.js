// Does the multi_step Noul correctly tell a chained command from a single
// action that merely contains "and"?
//
// The costly error is a FALSE SPLIT: "click the login and password fields"
// chopped into two commands does two wrong things instead of one right thing.

import { buildCommandQuestions, splitSteps } from "../extension/commands.js";
import { ELEMENTS, TYPEABLES, TABS, PAGE } from "./fixtures.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const CASES = [
  // Genuinely chained
  { say: "go to espn and click scores", steps: 2 },
  { say: "open gmail then search for invoices", steps: 2 },
  { say: "go to hacker news and scroll down", steps: 2 },
  { say: "reload the page and then scroll to the top", steps: 2 },
  { say: "go to wikipedia and click the search box", steps: 2 },
  { say: "open a new tab and go to github", steps: 2 },
  { say: "go to hacker news and then click the first story and scroll down", steps: 3 },

  // One action that happens to contain "and"
  { say: "click the login and password fields", steps: 1 },
  { say: "search for cats and dogs", steps: 1 },
  { say: "click the terms and conditions link", steps: 1 },
  { say: "go to bed bath and beyond", steps: 1 },
  { say: "type peace and quiet in the comment box", steps: 1 },
  { say: "scroll down", steps: 1 },
  { say: "close this tab", steps: 1 },
];

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let pass = 0, falseSplits = 0, missedChains = 0, tokens = 0;
const failures = [];

console.log(`\n${CASES.length} utterances · does it chain, or is it one action?\n`);
console.log(pad("utterance", 56), pad("split into", 12), pad("multi_step", 11), pad("verdict", 10), "ok");
console.log("-".repeat(102));

for (const c of CASES) {
  const steps = splitSteps(c.say);
  let noul = null;

  if (steps.length > 1) {
    const questions = buildCommandQuestions({ elements: ELEMENTS, tabs: TABS, typeables: TYPEABLES, steps });
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: { utterance: c.say, page: PAGE, elements: ELEMENTS, typeables: TYPEABLES, open_tabs: TABS },
        model: "jev-latest", questions,
      }),
    });
    if (!res.ok) { console.log(pad(c.say, 56), `ERROR ${res.status}`); continue; }
    const json = await res.json();
    tokens += json.usage.input_tokens;
    noul = json.answers.multi_step.noul;
  }

  const chains = steps.length > 1 && noul >= 0.6;
  const effective = chains ? steps.length : 1;
  const ok = effective === c.steps;

  if (ok) pass++;
  else if (c.steps === 1) { falseSplits++; failures.push([c.say, `FALSE SPLIT into ${effective}`, true]); }
  else { missedChains++; failures.push([c.say, `ran as one action, expected ${c.steps} steps`, false]); }

  console.log(
    pad(c.say, 56),
    pad(steps.length > 1 ? `${steps.length} candidate` : "1", 12),
    pad(noul === null ? "(not asked)" : noul.toFixed(2), 11),
    pad(chains ? `${steps.length} steps` : "one action", 10),
    ok ? "✓" : (c.steps === 1 ? "✗ FALSE SPLIT" : "✗ missed"),
  );
}

console.log("-".repeat(102));
console.log(`\n${pass}/${CASES.length} passed · ${tokens} tokens`);
console.log(`${falseSplits} false split(s) · ${missedChains} missed chain(s)\n`);
for (const [say, why] of failures) console.log(`  "${say}"\n      ${why}`);
if (failures.length) console.log();
process.exit(falseSplits ? 1 : 0);
