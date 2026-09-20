// The mode-confusion test. While writing an email, which utterances are words
// for the message and which are instructions to the assistant?
//
//   node --env-file=../.env dictation-harness.js
//
// The dangerous error is a FALSE CONTROL: content mistaken for an instruction,
// which sends a half-written email. A false content just types a stray line.

import { buildDictationQuestions, resolveDictation } from "../extension/dictation.js";

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) { console.error("TYPESAFE_API_KEY not set"); process.exit(1); }

const WRITING_INTO = "Message body — new email to sarah@example.com";
const SO_FAR = "Hi Sarah, thanks for sending the contract over. I read through it last night and had a couple of questions about the payment terms.";

// expect: what should happen. Tricky cases share words with controls.
const CASES = [
  // Plain content
  { say: "I wanted to follow up on our call yesterday", expect: "append" },
  { say: "could you clarify clause four before Friday", expect: "append" },
  { say: "thanks again for your patience with this", expect: "append" },
  { say: "best regards Dane", expect: "append" },

  // Content that LOOKS like a control — the dangerous direction
  { say: "send me the report tomorrow if you can", expect: "append" },
  { say: "I will send it over once legal signs off", expect: "append" },
  { say: "we should probably stop the project there", expect: "append" },
  { say: "let me know if you want me to clear the invoice", expect: "append" },
  { say: "can you delete that last paragraph from the draft", expect: "append" },
  { say: "I am done with the review", expect: "append" },
  { say: "that's it for now on my end", expect: "append" },

  // Genuine controls
  { say: "stop dictating", expect: "finish" },
  { say: "scratch that", expect: "undo" },
  { say: "new paragraph", expect: "new_paragraph" },
  { say: "send it", expect: "send" },
  { say: "okay send this email now", expect: "send" },
  { say: "actually erase everything", expect: "clear" },
  { say: "undo that last bit", expect: "undo" },
  { say: "start a new line", expect: "new_paragraph" },

  // Long content that leans hard on control vocabulary
  { say: "please stop sending me the weekly digest emails", expect: "append" },
  { say: "could you send this over to accounting when you get a chance", expect: "append" },
  { say: "I think we should clear the backlog before the next sprint", expect: "append" },
  { say: "feel free to scratch that idea if it does not work", expect: "append" },

  // Short genuine controls must survive the length rule
  { say: "erase all of it", expect: "clear" },
  { say: "go back one sentence", expect: "undo" },

  // Prose that mentions clicking or scrolling is still prose.
  { say: "click the link at the bottom of the page when you get it", expect: "append" },
  { say: "scroll down to the part about pricing and tell me", expect: "append" },
];

const questions = buildDictationQuestions();
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

let pass = 0, dangerous = 0, harmless = 0, tokens = 0, totalMs = 0;
const failures = [];

console.log(`\n${CASES.length} utterances while composing · ${Object.keys(questions).length} questions each\n`);
console.log(pad("utterance", 48), pad("content", 9), pad("control", 20), pad("→", 15), "ok");
console.log("-".repeat(100));

for (const c of CASES) {
  // Exact control phrases skip the model, exactly as the extension does.
  const quick = resolveDictation(null, c.say);
  let answers = null, decision = quick, ms = 0, local = quick.why === "control_phrase";

  if (!local) {
    const started = Date.now();
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: { utterance: c.say, writing_into: WRITING_INTO, text_so_far: SO_FAR },
        model: "jev-latest", questions,
      }),
    });
    if (!res.ok) { console.log(pad(c.say, 48), `ERROR ${res.status}`); continue; }
    const json = await res.json();
    answers = json.answers;
    ms = Date.now() - started;
    tokens += json.usage.input_tokens;
    totalMs += ms;
    decision = resolveDictation(answers, c.say);
  }

  const ok = decision.do === c.expect;
  if (ok) pass++;
  else {
    // Content wrongly treated as a control is the failure that costs you.
    const isDangerous = c.expect === "append";
    isDangerous ? dangerous++ : harmless++;
    failures.push([c.say, `expected ${c.expect}, got ${decision.do}`, isDangerous]);
  }

  console.log(
    pad(c.say, 48),
    pad(answers ? answers.is_content.noul.toFixed(2) : "(local)", 9),
    pad(answers ? `${answers.control.choice}@${answers.control.confidence.toFixed(2)}` : "—", 20),
    pad(decision.do, 15),
    ok ? "✓" : (c.expect === "append" ? "✗ DANGEROUS" : "✗"),
  );
}

console.log("-".repeat(100));
console.log(`\n${pass}/${CASES.length} passed · ${tokens} tokens · ${Math.round(totalMs / Math.max(1, CASES.length))}ms avg`);
console.log(`${dangerous} dangerous miss(es) (content treated as a command) · ${harmless} harmless miss(es)\n`);

if (failures.length) {
  for (const [say, why, bad] of failures) console.log(`  ${bad ? "DANGEROUS" : "harmless "}  "${say}"\n              ${why}`);
  console.log();
}
process.exit(dangerous ? 1 : 0);
