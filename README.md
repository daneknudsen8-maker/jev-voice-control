# jev — voice control for your browser

Speak to your browser. A Chrome extension captures speech, hands the transcript **plus the current
page's interactive elements** to TypeSafe's Jev model, and gets back a typed command that code executes.

The central design rule: **Jev selects, it never generates.** It does not write CSS selectors or URLs.
Code enumerates the candidates — every clickable element, every open tab, every known site — and Jev
picks one from that list. Dictated text comes verbatim from the speech transcript and never passes
through the model at all.

## Setup

**1. API key** — already in `.env` (gitignored, mode 600). Get one at https://console.typesafe.ai/

**2. Start the proxy.** It holds the API key so the extension never contains it:

```sh
cd proxy && npm start
# jev proxy on http://127.0.0.1:8787  ->  https://api.typesafe.ai/v1/systemone
```

**3. Load the extension.** `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select the `extension/` folder.

**4. Pin the proxy to your extension** (optional but recommended). Copy the extension's ID from
`chrome://extensions` and add to `.env`:

```
JEV_ALLOWED_EXTENSION_ID=abcdefgh...
```
Restart the proxy. Without it, any extension on your machine can reach the proxy.

**5. Pick where transcripts come from** — the dropdown in the panel header:

- **Chrome mic** — Chrome's Web Speech API. No setup, but the accuracy is mediocre on names and
  jargon, and the audio goes to Google's servers.
- **Wispr Flow / typing** — the panel shows a command box. Any tool that types into the focused field
  fills it: [Wispr Flow](https://wisprflow.ai), macOS dictation, or your keyboard. The command sends
  on Enter, or automatically when dictation stops. Much better accuracy; the cost is that **the box
  must stay focused**, since that is where the text lands.

The choice is remembered. Both live in `extension/speech/` behind one interface — implement
`start`/`stop`/`available` to add another.

**6. Open the panel.** Click the toolbar icon. A small window opens — **keep it open, it holds the
microphone.** Click *Start listening* (or press Space). Grant mic permission when Chrome asks.

## What you can say

| | |
|---|---|
| Moving | "scroll down", "back to the top", "go back", "reload the page" |
| Chaining | "go to espn and click scores", "open gmail then search for invoices" |
| Tasks | "find me an airbnb in austin for march 3rd to 7th", "fill out this form from that email" |
| Clicking | "click the login button", "open the comments on the Rust story", "show me the guidelines" |
| Typing | "type nice write-up in the comment box", "search this site for rust" |
| Writing | "compose a new email" → "to …", "cc …", "the subject should be …", "the body should say …" |
| Tabs | "new tab", "switch to the gmail tab", "close this tab", "close the youtube tab" |
| Tabs by position | "next tab", "previous tab", "go left two tabs", "switch back", "last tab" |
| By position | "open the second email", "click the third link", "open the last one" |
| By name alone | just say "Loom", "starred", "compose" — if it uniquely matches something on screen |
| Going places | "go to hacker news", "go to espn", "open github.com", "take me to arstechnica dot com" |
| Searching | "google mechanical keyboards" or "search for X" (the web) · "search this site for X" (the page's own box) |
| Asking | "is there anything about kubernetes here", "find the pricing section" |
| Stopping | "stop listening", "go to sleep" |

Navigation resolves in four steps, and only step 3 involves the model:

1. **An address you spoke** — "github.com", "arstechnica dot com" — used directly, no model needed.
2. **A site in `KNOWN_SITES`** ([extension/commands.js](extension/commands.js)) — edit that list freely.
3. **A single-word site name** — "go to espn" → `espn.com`, but only when a Noul judges that you are
   naming a site rather than describing something to find. Multi-word names are not guessed at, since
   "the new york times" is not `thenewyorktimes.com`.
4. **Anything else** — a web search built from exactly what you said.

If a named site is already open in a tab, it switches to that tab instead of reloading it.

Commands that don't need page content — navigating, tabs, history — work on a blank new tab, where
there is nothing to read.

## Positional and bare-name targeting

**Position:** "open the second email", "click the last link". Jev cannot count reliably, so each element
is **labelled** with its place in the page ("2nd of 6 links in main content") and Jev selects the label
instead of counting. A positional request also forces the first dozen elements in page order into the
candidate list, since position is about where things sit, not how well their text matches.

**Tab position** — "next tab", "go left two tabs", "switch back" — is arithmetic, so code handles it
entirely. No model call, and "switch back" uses a real last-used-tab history.

**A spoken verb wins.** "Click on X" is an instruction about the page in front of you, so it clicks —
it never switches to a tab that happens to have X open, however well that tab matches. "Go to X" stays
free to prefer an already-open tab, and "open X" too, since those really can mean the tab.

**Things on the page win.** "go to CMC email" on a page of bookmark tiles means the tile. Naming
something visible resolves to clicking it, ahead of switching to a loosely-matching tab or guessing a
URL — a shortcut you put there yourself is more specific than a generic domain. This also settles
genuinely split actions: click, switch_tab and navigate all mean "open this thing", so probability
spread across them is not real uncertainty, and an unambiguous target decides it.

**Bare names:** saying just "Loom" or "starred" reads as conversation and scores low on `is_command`, so
it used to be dropped. It is now allowed, but only when the words **uniquely** match one open tab or one
element on the page. Microphone noise matches nothing and is still dropped.

## Giving it a task

Say a goal rather than a command — "find me an airbnb in austin for march 3rd to 7th", "fill out this
form using the details in that email" — and it works towards it a step at a time, showing each step as
it goes.

**How it works, and what that costs.** Jev is not an agent model: it does not plan, does not generate,
and does not choose its own next action in any open-ended sense. So code owns the loop — counting
steps, executing, waiting for pages, detecting repeats — and Jev answers one bounded question per
turn: *given this goal and this page, what is the single next thing to do?*

That makes the loop **greedy**. It follows an obvious path well. It cannot plan several moves ahead,
and it cannot improvise when a site does something unexpected. Starting on an unrelated page it will
search the web for the goal first, then carry on from the results.

**Dates are left to the model.** Given only today's date it picks the right calendar day for
"tomorrow" (1.00), "in three days" (0.97 — real arithmetic), "next friday" (0.97) and "the 25th"
(1.00), and correctly says "none of these" for a date the calendar does not show. `today` is supplied
because it has no clock; nothing else is.

A previous version pre-computed dates in code. Measured, that bought one case in eight and *cost* a
case it had right at 0.97, because a bug in the computation was believed over the plain wording. It
was deleted.

**Repeated clicks are allowed when the page reacts.** Pressing "+" on a guest counter six times is the
same click six times, so a repeat only counts as stuck when the page did not change. The loop presses
"+" from 1 to 7 and then moves to Search on its own (0.97–0.99 throughout).

**Values are selected, never invented.** For a typing step, code enumerates every phrase in your goal
and every value already on the page, and Jev picks which one belongs in the field. So "fill this in
from that email" works, while "write a paragraph about X" does not — there is nothing to select from.

**It stops for anything consequential.** Each step is scored 0–3 for how hard it is to undo, and
anything at 1.5 or above waits for you — booking, paying, submitting, sending. You approve, and the
loop carries on from there.

The command box takes typed input at any time, whichever transcript source is selected: Enter to send,
Shift+Enter for a new line, or the Send button. It grows with the text, so a long goal is easier to
type than to dictate.

| It stops when | |
|---|---|
| the goal is met | judged fresh each turn against the page |
| it gets stuck | nothing on the page advances the goal |
| a step repeats | the same click or entry twice means the last one did nothing |
| 25 steps | hard limit, so a loop it does not understand cannot run away |
| you say so | the stop button, any time |

```sh
cd test && node --env-file=../.env task-harness.js
# 13/13 — telling a goal from a command, and picking the next step
```

## Chained commands

Say two things at once — "go to espn **and** click scores", "open gmail **then** search for invoices" —
and each step runs in turn.

Each step is resolved **after** the previous one finishes, against the page as it then stands. It has to
be: "click scores" cannot be resolved until espn has loaded and its elements exist. The extension waits
for the page to settle between steps.

Splitting is done in code, but whether the split is *real* is a judgment — "click the login **and**
password fields" is one action, not two. A Noul decides, and the margin is wide: genuine chains score
0.94–0.98, single actions 0.06–0.17.

If a step needs an answer from you — a confirmation, or a "which one did you mean" — the chain stops
there, since the remaining steps were written for a page that may now never appear.

```sh
cd test && node --env-file=../.env multistep-harness.js
# 14/14 passed · 0 false splits
```

## Writing an email

Say **"compose a new email"**. If there's no composer open it clicks the button that opens one, then
binds the whole **form** — recipient, cc, subject, body — not a single box.

From there, name a field and speak its value. They can be separate utterances:

```
"to"                                    → switches to the To field, waits
"Sarah Chen"                            → goes into To
"subject line should be"                → switches to Subject
"new tool"                              → goes into Subject
"the body should say hi Sarah, ..."     → names and fills Body in one breath
"cc Marco"                              → To/Cc/Bcc all work the same way
```

**The chosen field persists.** Once you're in the body, everything you say keeps going there until you
name another field — so you can dictate several sentences without repeating yourself.

The panel shows the email taking shape with the active field marked, so you can see where your words
are landing.

Spoken addresses are converted in code: "marco at example dot com" becomes `marco@example.com`. Plain
names are left alone, and so is a body that happens to say "meet at the dot com place".

Which field an utterance belongs to, when you don't name one, is the judgment Jev makes. Naming one is
string work, so code reads it — and a named field always wins, so "cc Sarah" is never mistaken for a
command.

```sh
cd test && node --env-file=../.env compose-harness.js
# 16/16 — replays a real failed session as its first script
```

## Writing longer text

Say **"write an email"**, **"compose a message"**, or **"start dictating in the comment box"** and the
panel switches to writing mode: everything you say is appended to that field until you say otherwise.

| While writing | |
|---|---|
| Any sentence | appended to the message |
| "new paragraph" / "new line" | line break |
| "scratch that" | removes the last thing written |
| "erase everything" | clears the field (confirms first) |
| "send it" | submits the form (confirms first, showing the full text) |
| "stop dictating" | leaves the text as written |

Say punctuation out loud — "period", "comma", "question mark", "dash" — and it's converted in code.
Capitals and spacing are handled for you.

### How it avoids sending your half-written email

This is the hard part of any voice interface. While writing, "send me the report tomorrow" is content
and "send it" is a command, and they share words. Three defences, in order of trust:

1. **Exact phrases in code.** "stop dictating", "scratch that" — deterministic, no model, no ambiguity.
2. **A length rule in code.** Real controls are short imperatives. Seven words or more is presumptively
   part of your message and needs overwhelming evidence to be read as an instruction.
3. **Jev judges the rest** — with the question framed around *who is being addressed*. Content talks to
   your recipient and may freely mention sending or deleting things in the world; an instruction talks
   to the assistant about the words just spoken.

**The default is always to write it down.** A control mistaken for content costs you a line to delete;
content mistaken for a control sends a half-finished email. Those are not equal, so the safe direction
is baked in. Sending and erasing confirm first regardless.

`test/dictation-harness.js` measures exactly this, and reports *dangerous* misses (content treated as a
command) separately from harmless ones:

```sh
cd test && node --env-file=../.env dictation-harness.js
# 25/25 passed · 0 dangerous misses
```

## Safety

Every utterance gets a **risk** Score (0–3) for how hard it is to undo. Anything at 1.6 or above, or
whose target text matches a danger pattern, asks for confirmation before acting.

Closing the tab you're looking at just runs — it's explicit, and cmd-shift-T brings it back. Closing a
tab you *named but can't see* confirms first, since that's where a misheard word does damage. That
split is policy in code, not a judgment left to the model.

A low-confidence target offers you the top three candidates instead of guessing. Speech that isn't
addressed to the browser is dropped on an `is_command` probability below 0.5 — in testing, ordinary
conversation scores 0.03–0.04 while real commands score 0.90+.

Thresholds are all at the top of [extension/commands.js](extension/commands.js) (`FLOORS`,
`CONFIRM_RISK`, `DANGER`). **Tune them on your own speech** — the current values are a starting point.

## Closing gaps after a session — `/voice-gaps`

In Claude Code, run **`/voice-gaps`**. It reads your most recent session, separates commands that
should have worked from ones correctly refused, fixes the real gaps, and proves the fix with tests.

The analysis it runs is available on its own:

```sh
cd test && node session.js          # the most recent session
node session.js --n 2               # the one before that
node session.js --json              # full detail, every candidate element
```

A session is a run of commands with no gap longer than 15 minutes. Commands are sorted four ways, and
only the last is a problem:

| | |
|---|---|
| `worked` | ran as intended |
| `refused by design` | a confirmation or risk gate doing its job |
| `noise ignored` | dropped, and nothing on screen matched — the mic working correctly |
| `gaps` | should have worked and didn't |

That separation matters: a voice tool hears side conversation constantly, and counting every ignored
phrase as a failure would bury the real ones.

## Seeing why a command did or didn't run

Every utterance is recorded with the gate that decided it:

```sh
node test/report.js                       # every command, ran or not, and why
node test/report.js --failed              # only what didn't run
node test/report.js --why target_no_match # drill in, with the full candidate list
```

On a missed click the decisive question is whether the right element was even among the candidates.
Absent → the ranking in [content.js](extension/content.js) is at fault. Present but not chosen → the
question wording is. The drill-down prints the candidate list so you can tell which.

## Testing without a browser

`test/harness.js` runs the real question design against the real model over a fixture page, so you can
iterate on prompt wording without loading the extension or speaking a word:

```sh
cd test && node --env-file=../.env harness.js
# 35/35 passed · 193ms avg · $0.005 per run

node --env-file=../.env harness.js --blank    # same, on an empty tab with no page
node --env-file=../.env harness.js delete     # just matching utterances
```

Add cases to `test/fixtures.js`. Each case is one API call; a full run costs about a third of a cent.

## How a command flows

```
panel.html          mic → transcript                    (Web Speech API, swappable)
   ↓
background.js       matchLocalCommand()                 stop/sleep never reach the model
   ↓
content.js          inventory: rank + cap page elements  ~70 clickable, ~12 fields
   ↓
background.js       ONE request, 8 questions in parallel
                      action · is_command · risk · scroll_direction
                      destination · target · field · tab_target
   ↓
commands.js         resolveCommand() reads only what this action needs
   ↓                confidence floors → execute / confirm / choose / clarify / ignore
content.js          click, type, scroll, highlight
```

Everything is one request. The questions that don't apply to a given utterance are simply never read —
that's the **speculative fan-out** pattern, and it's why this runs in ~220 ms instead of several
sequential round trips. A second request happens only for "ask a question about this page", which
genuinely needs different state (page prose, not page controls).

Element inventories are **ranked and capped in code** before they're sent — lexical overlap with what
you said, plus on-screen position. Jev degrades on large states full of irrelevant detail, so a
500-link page never ships 500 options.

## Layout

```
proxy/server.js        holds the API key; the only thing that talks to TypeSafe
extension/
  manifest.json        MV3
  background.js        orchestrator: tabs, proxy calls, decision dispatch
  commands.js          ← the Jev question design. Start here.
  content.js           page element inventory + command execution
  panel.html/.js/.css  mic + transcript + activity log
  task.js              the task loop: next-step judgment, value selection
  compose.js           structured email: field routing, spoken addresses
  dictation.js         writing mode: content vs command, punctuation, appending
  speech/index.js      transcript sources: webspeech.js (mic), textinput.js (Wispr Flow)
test/
  harness.js           browser-free evaluation against live Jev
  dictation-harness.js mode-confusion tests; fails loudly on dangerous misses
  multistep-harness.js chained commands vs single actions containing "and"
  ordinal-harness.js   positional targeting over a realistic inbox
  newtab-harness.js    bookmark tiles on a new-tab page
  compose-harness.js   email field routing, scripted as conversations
  task-harness.js      goal vs command, and next-step selection
  session.js           groups the trace into sessions; separates gaps from noise
.claude/skills/
  voice-gaps/          the /voice-gaps command
  fixtures.js          fake page, tabs, and the expected outcomes
docs/typesafe/         full local TypeSafe docs — read 00-core.md first
```

## Known limits

- **Web Speech API sends audio to Google**, and is weak on names and jargon. The "Wispr Flow / typing"
  source avoids both, at the cost of keeping the command box focused — if focus moves to the web page,
  the next thing you dictate is typed into that page instead. The panel warns when the box loses
  focus, and clicking anywhere in the panel restores it.
- The panel window must stay open. A popup would close on blur and kill the mic.
- Same-page only: no iframes (`all_frames: false`), and no `chrome://` pages.
- Element ids are rebuilt on each utterance. If the page changes between speaking and executing, the
  click reports "element is gone" rather than clicking the wrong thing.
