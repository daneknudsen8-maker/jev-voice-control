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
| Moving | "scroll down", "back to the top", "go back", "reload" |
| Clicking | "click the login button", "open the comments on the Rust story", "show me the guidelines" |
| Typing | "search for rust async", "type nice write-up in the comment box" |
| Tabs | "new tab", "switch to the gmail tab", "close the youtube tab" |
| Going places | "go to hacker news", "take me to wikipedia" |
| Asking | "is there anything about kubernetes here", "find the pricing section" |
| Stopping | "stop listening", "go to sleep" |

Sites reachable by name live in `KNOWN_SITES` in [extension/commands.js](extension/commands.js) — edit
freely. Anything not in the list becomes a web search built from what you actually said.

If a named site is already open in a tab, it switches to that tab instead of reloading it.

## Safety

Every utterance gets a **risk** Score (0–3) for how hard it is to undo. Anything at 1.6 or above, or
whose target text matches a danger pattern, asks for confirmation before acting. Closing a tab always
confirms — that's a policy decision in code, not a judgment left to the model, since a tab may hold
unsaved work.

A low-confidence target offers you the top three candidates instead of guessing. Speech that isn't
addressed to the browser is dropped on an `is_command` probability below 0.5 — in testing, ordinary
conversation scores 0.03–0.04 while real commands score 0.90+.

Thresholds are all at the top of [extension/commands.js](extension/commands.js) (`FLOORS`,
`CONFIRM_RISK`, `DANGER`). **Tune them on your own speech** — the current values are a starting point.

## Testing without a browser

`test/harness.js` runs the real question design against the real model over a fixture page, so you can
iterate on prompt wording without loading the extension or speaking a word:

```sh
cd test && node --env-file=../.env harness.js
# 22/22 passed · 70997 input tokens · 220ms avg · $0.003 per run

node --env-file=../.env harness.js "delete"   # just matching utterances
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
  speech/index.js      swappable STT; webspeech.js is the default
test/
  harness.js           browser-free evaluation against live Jev
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
