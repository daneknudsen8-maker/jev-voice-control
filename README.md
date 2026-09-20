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

**5. Open the panel.** Click the toolbar icon. A small window opens — **keep it open, it holds the
microphone.** Click *Start listening* (or press Space). Grant mic permission when Chrome asks.

## What you can say

| | |
|---|---|
| Moving | "scroll down", "back to the top", "go back", "reload the page" |
| Chaining | "go to espn and click scores", "open gmail then search for invoices" |
| Clicking | "click the login button", "open the comments on the Rust story", "show me the guidelines" |
| Typing | "type nice write-up in the comment box", "search this site for rust" |
| Writing | "write an email", "let me dictate a comment" → then just talk |
| Tabs | "new tab", "switch to the gmail tab", "close this tab", "close the youtube tab" |
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
  dictation.js         writing mode: content vs command, punctuation, appending
  speech/index.js      swappable STT; webspeech.js is the default
test/
  harness.js           browser-free evaluation against live Jev
  dictation-harness.js mode-confusion tests; fails loudly on dangerous misses
  multistep-harness.js chained commands vs single actions containing "and"
  fixtures.js          fake page, tabs, and the expected outcomes
docs/typesafe/         full local TypeSafe docs — read 00-core.md first
```

## Known limits

- **Web Speech API sends audio to Google.** That's how Chrome implements it. `speech/index.js` is a
  swappable interface — implement `start`/`stop`/`available` over local whisper.cpp to keep audio on
  your machine.
- The panel window must stay open. A popup would close on blur and kill the mic.
- Same-page only: no iframes (`all_frames: false`), and no `chrome://` pages.
- Element ids are rebuilt on each utterance. If the page changes between speaking and executing, the
  click reports "element is gone" rather than clicking the wrong thing.
