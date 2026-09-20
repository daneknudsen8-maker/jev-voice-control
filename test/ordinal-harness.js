// Positional targeting: "open the second email", "click the last link".
// Jev cannot count, so each element carries a position LABEL and Jev selects it.

import { buildCommandQuestions, resolveCommand } from "../extension/commands.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

// An inbox, numbered the way content.js numbers a real page.
const SENDERS = ["Sarah Chen", "GitHub", "Anna Whitfield", "Stripe", "Dev Weekly", "Marco Reyes"];
const ELEMENTS = [
  { id: "e0", text: "Compose", kind: "button", where: "navigation" },
  { id: "e1", text: "Inbox", kind: "link", where: "navigation", position: "1st of 4" },
  { id: "e2", text: "Starred", kind: "link", where: "navigation", position: "2nd of 4" },
  { id: "e3", text: "Sent", kind: "link", where: "navigation", position: "3rd of 4" },
  { id: "e4", text: "Drafts", kind: "link", where: "navigation", position: "4th of 4", last: true },
  ...SENDERS.map((name, i) => ({
    id: `e${10 + i}`,
    text: `${name} — ${["Contract questions","PR #2213 merged","Lunch Thursday?","Your receipt","Issue 402","Re: onboarding"][i]}`,
    kind: "link", where: "main content",
    position: `${["1st","2nd","3rd","4th","5th","6th"][i]} of 6`,
    last: i === 5 || undefined,
  })),
];
const TYPEABLES = [{ id: "e30", text: "Search mail", kind: "search input", where: "navigation" }];
const TABS = [{ id: "t1", title: "Calendar", host: "calendar.google.com" }];
const PAGE = { title: "Inbox (6)", url: "https://mail.example.com/inbox", host: "mail.example.com" };

const CASES = [
  { say: "open the second email", target: "e11" },
  { say: "open the first email", target: "e10" },
  { say: "click the third email", target: "e12" },
  { say: "open the last email", target: "e15" },
  { say: "open the email from Anna", target: "e12" },     // by name, not position
  { say: "click the fifth one", target: "e14" },
  { say: "open starred", target: "e2" },
  { say: "click compose", target: "e0" },
];

const questions = buildCommandQuestions({ elements: ELEMENTS, tabs: TABS, typeables: TYPEABLES });
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const byId = new Map(ELEMENTS.map((e) => [e.id, e]));
let pass = 0; const failures = [];

console.log(`\n${CASES.length} positional targets · ${ELEMENTS.length} elements on the page\n`);
console.log(pad("utterance", 30), pad("chose", 8), pad("conf", 6), pad("which element", 44), "ok");
console.log("-".repeat(96));

for (const c of CASES) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      state: { utterance: c.say, page: PAGE, elements: ELEMENTS, typeables: TYPEABLES, open_tabs: TABS },
      model: "jev-latest", questions,
    }),
  });
  if (!res.ok) { console.log(pad(c.say, 30), `ERROR ${res.status}`); continue; }
  const { answers } = await res.json();
  const d = resolveCommand(answers, { transcript: c.say, elements: ELEMENTS, typeables: TYPEABLES, tabs: TABS, readable: true });
  const chosen = d.command?.id ?? d.kind;
  const ok = chosen === c.target;
  ok ? pass++ : failures.push([c.say, `expected ${c.target} ("${byId.get(c.target)?.text}"), got ${chosen} ("${byId.get(chosen)?.text ?? d.kind}")`]);
  console.log(
    pad(c.say, 30), pad(chosen, 8),
    pad(answers.target ? answers.target.confidence.toFixed(2) : "—", 6),
    pad(byId.get(chosen)?.text ?? d.kind, 44), ok ? "✓" : "✗",
  );
}

console.log("-".repeat(96));
console.log(`\n${pass}/${CASES.length} passed\n`);
for (const [say, why] of failures) console.log(`  "${say}"\n      ${why}`);
process.exit(pass === CASES.length ? 0 : 1);
