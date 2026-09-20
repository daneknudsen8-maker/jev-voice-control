// Two things a task loop must get right before it can be trusted:
//   1. Knowing a goal from a single command. "find me an airbnb" is a task;
//      "click the login link" is not, and running a loop on it would be wrong.
//   2. Picking a sensible next step, and knowing when it is finished.
//
// The loop is greedy by construction, so this checks each step in isolation
// against a page, not a whole journey.

import { buildCommandQuestions, resolveCommand } from "../extension/commands.js";
import { buildTaskQuestions, resolveTaskStep, valueCandidates } from "../extension/task.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const ask = async (state, questions) => {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).answers;
};

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let pass = 0, total = 0;
const failures = [];
const check = (ok, label, detail) => { total++; ok ? pass++ : failures.push([label, detail]); return ok ? "✓" : "✗"; };

// ---------------------------------------------------------------- part one
// A task must be told from an ordinary command.

const ELEMENTS = [
  { id: "e0", text: "Log in", kind: "link", where: "navigation" },
  { id: "e1", text: "Search", kind: "button", where: "main content" },
  { id: "e2", text: "Austin, TX", kind: "link", where: "main content" },
];
const TYPEABLES = [{ id: "e9", text: "Where are you going?", kind: "search input", where: "main content" }];
const TABS = [{ id: "t1", title: "Gmail", host: "mail.google.com" }];

const CLASSIFY = [
  { say: "find me an airbnb in austin for march 3rd to 7th", task: true },
  { say: "fill out this form using the details in that email", task: true },
  { say: "book a table for two on friday", task: true },
  { say: "search for flights to denver and show me the cheapest", task: true },
  { say: "click the login link", task: false },
  { say: "scroll down", task: false },
  { say: "go to gmail", task: false },
  { say: "close this tab", task: false },
  { say: "open the second email", task: false },
];

console.log(`\n\x1b[1mtask or ordinary command?\x1b[0m\n`);
console.log(pad("utterance", 50), pad("action", 12), pad("conf", 6), "ok");
console.log("-".repeat(76));

const cmdQuestions = buildCommandQuestions({ elements: ELEMENTS, tabs: TABS, typeables: TYPEABLES });
for (const c of CLASSIFY) {
  const answers = await ask(
    { utterance: c.say, page: { title: "Airbnb" }, elements: ELEMENTS, typeables: TYPEABLES, open_tabs: TABS },
    cmdQuestions,
  );
  const d = resolveCommand(answers, { transcript: c.say, elements: ELEMENTS, typeables: TYPEABLES, tabs: TABS, readable: true });
  const isTask = d.kind === "task";
  const mark = check(isTask === c.task, c.say, `expected ${c.task ? "task" : "ordinary command"}, got ${d.kind}`);
  console.log(pad(c.say, 50), pad(answers.action.choice, 12), pad(answers.action.confidence.toFixed(2), 6), mark);
}

// ---------------------------------------------------------------- part two
// Given a goal and a page, is the next step sensible?

const GOAL = "find me an airbnb in austin for march 3rd to 7th";

const PAGES = [
  {
    name: "airbnb home, nothing filled in",
    page: { title: "Airbnb | Vacation rentals", url: "https://airbnb.com" },
    elements: [
      { id: "e0", text: "Airbnb", kind: "link", where: "navigation" },
      { id: "e1", text: "Log in", kind: "button", where: "navigation" },
      { id: "e2", text: "Search", kind: "button", where: "main content" },
      { id: "e3", text: "Check in", kind: "button", where: "main content" },
      { id: "e4", text: "Check out", kind: "button", where: "main content" },
    ],
    typeables: [{ id: "e10", text: "Where are you going?", kind: "search input", where: "main content" }],
    history: [],
    expect: { action: ["type", "click"], notDone: true },
  },
  {
    name: "destination filled, dates empty",
    page: { title: "Airbnb | Vacation rentals", url: "https://airbnb.com" },
    elements: [
      { id: "e2", text: "Search", kind: "button", where: "main content" },
      { id: "e3", text: "Check in — add dates", kind: "button", where: "main content" },
      { id: "e4", text: "Check out — add dates", kind: "button", where: "main content" },
    ],
    typeables: [{ id: "e10", text: "Austin, TX", kind: "search input", where: "main content" }],
    history: ['type "austin" into Where are you going?'],
    expect: { action: ["click"], notDone: true },
  },
  {
    name: "results are showing",
    page: { title: "Austin stays Mar 3–7 | Airbnb", url: "https://airbnb.com/s/Austin" },
    elements: [
      { id: "e20", text: "Loft in East Austin · $180 night", kind: "link", where: "main content", position: "1st of 3" },
      { id: "e21", text: "House near downtown · $240 night", kind: "link", where: "main content", position: "2nd of 3" },
      { id: "e22", text: "Condo on South Congress · $150 night", kind: "link", where: "main content", position: "3rd of 3" },
    ],
    typeables: [],
    history: ['type "austin" into Where', 'click "Check in"', 'click "Mar 3"', 'click "Search"'],
    expect: { done: true },
  },
  {
    name: "wrong site entirely",
    page: { title: "Wikipedia", url: "https://en.wikipedia.org" },
    elements: [
      { id: "e30", text: "Main page", kind: "link", where: "navigation" },
      { id: "e31", text: "Random article", kind: "link", where: "navigation" },
    ],
    typeables: [{ id: "e32", text: "Search Wikipedia", kind: "search input", where: "navigation" }],
    history: [],
    expect: { action: ["search_web", "type"], stuckOk: true, notDone: true },
  },
];

console.log(`\n\x1b[1mnext step, given "${GOAL}"\x1b[0m\n`);
console.log(pad("page", 34), pad("next", 10), pad("conf", 6), pad("goal_met", 9), pad("resolved", 34), "ok");
console.log("-".repeat(100));

for (const p of PAGES) {
  const values = valueCandidates(GOAL, p.typeables.map((t) => t.text));
  const answers = await ask(
    { goal: GOAL, step_number: p.history.length + 1, page: p.page, elements: p.elements, typeables: p.typeables, history: p.history },
    buildTaskQuestions({ elements: p.elements, typeables: p.typeables, values }),
  );
  const step = resolveTaskStep(answers, { values, history: [], elements: p.elements, typeables: p.typeables, goal: GOAL });

  let ok;
  if (p.expect.done) ok = step.do === "done";
  else if (p.expect.stuckOk) ok = step.do === "stuck" || step.do === "act";
  else ok = step.do === "act" && p.expect.action.includes(answers.next_action.choice);
  if (p.expect.notDone && step.do === "done") ok = false;

  const mark = check(ok, p.name, `got ${step.do} (${step.label ?? step.detail ?? ""})`);
  console.log(
    pad(p.name, 34), pad(answers.next_action.choice, 10),
    pad(answers.next_action.confidence.toFixed(2), 6),
    pad(answers.goal_met.noul.toFixed(2), 9),
    pad(step.label ?? `${step.do}: ${step.why}`, 34), mark,
  );
}

console.log("-".repeat(100));
console.log(`\n${pass}/${total} passed\n`);
for (const [label, detail] of failures) console.log(`  ${label}\n      ${detail}`);
process.exit(pass === total ? 0 : 1);
