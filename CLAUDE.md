# jev

Voice control for Chrome, built on the **TypeSafe Jev API** (System One model: typed judgments with
calibrated probabilities, not generated text). See [README.md](README.md) for setup and usage.

**Architecture in one line:** `panel.html` (mic) → `background.js` (orchestrator) → one 8-question Jev
request carrying the transcript plus the page's element inventory → `commands.js` resolves it →
`content.js` executes. The API key lives only in `proxy/server.js`.

**The rule the whole design rests on: Jev selects, it never generates.** Element targets, tab targets
and destinations are all Choice options that code enumerated first. Dictated text comes verbatim from
the ASR transcript. If you find yourself asking Jev to produce a selector, a URL, or any free text,
that is the bug.

**`extension/commands.js` is the file that matters.** The question design, the confidence floors and
the risk policy are all there.

**Test without a browser:** `cd test && node --env-file=../.env harness.js` runs 22 utterances against
the live model over a fixture page (~$0.003, ~220ms each). Add cases to `test/fixtures.js`. Run it
after any change to question wording — prompt regressions are invisible otherwise.

## Docs are local — do not fetch them

A complete copy of the TypeSafe documentation lives in [docs/typesafe/](docs/typesafe/), captured
2026-09-19 against `jev-1.13.0`.

**Read [docs/typesafe/00-core.md](docs/typesafe/00-core.md) before writing any TypeSafe integration code.**
It has the full request/response shape, all three primitives, confidence semantics, limits and pricing.
Then [01-limits.md](docs/typesafe/01-limits.md) for known failure modes,
[02-sdks.md](docs/typesafe/02-sdks.md) for SDK usage, and
[03-design-patterns.md](docs/typesafe/03-design-patterns.md) for how to decompose a problem into questions.

All 109 original doc pages are mirrored locally in `docs/typesafe/reference/` (gitignored — not
committed, so a fresh clone will not have it; rebuild per docs/typesafe/README.md).
Only go to the network if you have reason to believe something changed since the capture date — and note
that pricing and rate limits are the parts most likely to have moved.

The `typesafe:typesafe-ai` skill is installed and points at the live docs; prefer the local copy above.

## Easy things to get wrong

- **Batch questions.** Put every question the code might need in ONE `systemOne` call, speculative ones
  included. They evaluate in parallel at ~no latency cost and ~12× lower cost than separate calls.
  One-question-per-call is the most common agent mistake with this API.
- **Keep arithmetic, counting, date comparison and exact lookups in code.** Jev is documented as
  unreliable at all of these.
- **Noul has no `confidence`.** A Noul of 0.5 means "yes and no are equally likely", not "medium".
- **Don't carry a threshold tuned on a Noul over to a Choice.** They answer different questions.

## Secrets

`TYPESAFE_API_KEY` lives in `.env`, which is gitignored (mode 600). `.env.example` is the committable
template. Never inline the key, never expose it to a browser bundle, never pass
`dangerouslyAllowBrowser`.
