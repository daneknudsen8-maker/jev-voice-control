// The Google new-tab page with shortcut tiles, from a real screenshot.
// "go to CMC email" means the TILE, not an open tab and not a web search.

import { buildCommandQuestions, resolveCommand } from "../extension/commands.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const TILES = ["CMC email", "CMC docs", "Gcal", "LinkedIn", "WSJ", "personal docs",
               "desmos calc", "Bloomberg", "CMC drive", "HMC Email"];

const ELEMENTS = [
  { id: "e0", text: "Gmail", kind: "link", where: "navigation" },
  { id: "e1", text: "Images", kind: "link", where: "navigation" },
  { id: "e2", text: "Google apps", kind: "button", where: "navigation" },
  ...TILES.map((t, i) => ({
    id: `e${10 + i}`, text: t, kind: "link", where: "main content",
    position: `${i + 1}${["st","nd","rd"][i] ?? "th"} of ${TILES.length}`,
  })),
  { id: "e30", text: "Show less", kind: "button", where: "main content" },
  { id: "e31", text: "AI Mode", kind: "button", where: "main content" },
];
const TYPEABLES = [{ id: "e40", text: "Ask Google", kind: "search input", where: "main content" }];

// Deliberately NO tab matching "CMC email" — that was the real situation.
const TABS = [{ id: "t1", title: "Recent Canvas Notifications", host: "mail.claremontmckenna.edu" }];
const PAGE = { title: "New Tab", url: "https://www.google.com", host: "www.google.com" };

const CASES = [
  { say: "go to CMC email",      target: "e10" },
  { say: "open CMC docs",        target: "e11" },
  { say: "go to Gcal",           target: "e12" },
  { say: "open LinkedIn",        target: "e13" },
  { say: "click desmos calc",    target: "e16" },
  { say: "open HMC Email",       target: "e19" },
  { say: "go to Bloomberg",      target: "e17" },
];

const questions = buildCommandQuestions({ elements: ELEMENTS, tabs: TABS, typeables: TYPEABLES });
const byId = new Map([...ELEMENTS, ...TYPEABLES].map((e) => [e.id, e]));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
let pass = 0; const failures = [];

console.log(`\n${CASES.length} tiles on a new-tab page · no matching tab open\n`);
console.log(pad("utterance", 24), pad("action", 12), pad("conf", 6), pad("resolved", 34), "ok");
console.log("-".repeat(88));

for (const c of CASES) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      state: { utterance: c.say, page: PAGE, elements: ELEMENTS, typeables: TYPEABLES, open_tabs: TABS },
      model: "jev-latest", questions,
    }),
  });
  if (!res.ok) { console.log(pad(c.say, 24), `ERROR ${res.status}`); continue; }
  const { answers } = await res.json();
  const d = resolveCommand(answers, { transcript: c.say, elements: ELEMENTS, typeables: TYPEABLES, tabs: TABS, readable: true });

  const clicked = d.command?.do === "click" ? d.command.id : null;
  const ok = clicked === c.target;
  ok ? pass++ : failures.push([c.say, `expected click ${c.target} ("${byId.get(c.target)?.text}"), got ${d.kind} ${JSON.stringify(d.command ?? "")} [${d.why}]`]);

  console.log(
    pad(c.say, 24), pad(answers.action.choice, 12), pad(answers.action.confidence.toFixed(2), 6),
    pad(clicked ? `click "${byId.get(clicked)?.text}"` : `${d.kind} [${d.why}]`, 34),
    ok ? "✓" : "✗",
  );
}

console.log("-".repeat(88));
console.log(`\n${pass}/${CASES.length} passed\n`);
for (const [say, why] of failures) console.log(`  "${say}"\n      ${why}`);
process.exit(pass === CASES.length ? 0 : 1);
