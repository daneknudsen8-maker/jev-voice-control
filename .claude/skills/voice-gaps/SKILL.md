---
name: voice-gaps
description: Analyze the most recent voice-control session, find commands that should have worked but didn't, and implement the fixes. Use when the user asks to review recent voice queries, fix commands that failed, or close gaps in the Jev voice extension.
---

# Fix what didn't work in the last voice session

Read the real trace, separate genuine gaps from correct refusals, fix the gaps, prove the fix.

## 1. Read the session

```sh
cd test && node session.js
```

Add `--json` for full detail including every candidate element, `--n 2` for the session before last,
`--all` for everything. A session is a run of commands with no gap longer than 15 minutes.

The report sorts commands four ways. **Only `gaps` are yours to fix:**

| Bucket | Meaning |
|---|---|
| `worked` | ran as intended |
| `refused by design` | a confirmation or risk gate — working correctly |
| `noise ignored` | dropped, and nothing on screen matched — the microphone doing its job |
| `gaps` | should have worked and didn't |

If the trace is empty, the extension hasn't been reloaded since tracing was added, or the proxy isn't
running (`cd proxy && npm start`). Say so rather than inventing an analysis.

## 2. Judge each gap before fixing it

**Not every gap deserves a fix.** Ask, in order:

1. **Was the transcript right?** Speech recognition errors ("casino Bank" for a name) cannot be fixed
   downstream. Note them; don't chase them.
2. **Was the user talking to the browser at all?** Side conversation picked up by the mic is correctly
   ignored even when it mentions browser words.
3. **Is it one-off or repeated?** Repeated failures are worth real design work; a single odd phrasing
   usually isn't.

Then find where it actually broke, which the confidences tell you:

- **Jev confident and right, but nothing happened** → the bug is in the plumbing, not the model. This
  has been the cause of most failures in this project: a missing permission, a guard clause in the
  wrong place, a question asked only conditionally.
- **Jev confident and wrong** → the question wording is wrong. The explanation you would give for why
  it should have chosen differently *is the missing half of the instruction*.
- **Jev unconfident** → either the options genuinely overlap, or the right answer was never offered.

For `target_no_match`, the report prints the candidate list. **Check whether the right element is in
it.** Absent → fix ranking in `extension/content.js`. Present but unchosen → fix the target question
wording in `extension/commands.js`. Opposite fixes; don't guess which.

## 3. Decide where the fix belongs

The single most important call, and the project's guiding rule:

**Code owns:** arithmetic, counting, position and ordering, dates, exact phrases, mode and state,
string parsing, anything with one right answer. Jev is documented as unreliable at all of these —
see `docs/typesafe/01-limits.md`.

**Jev owns:** genuine judgment about meaning. Which of these elements did they mean, is this content
or a command, does this page answer the question.

Past fixes that followed this rule: tab position ("go left one tab" scored 0.17) moved to code;
ordinals became position *labels* so Jev selects instead of counting; dictation controls became exact
phrases plus a length rule. Reach for a code fix before a prompt fix when the thing has one right
answer.

**Never ask Jev to generate.** Elements, tabs, destinations and fields are all enumerated by code and
selected by Jev. If a fix has you asking it to produce a selector, URL, or free text, that is the bug.

## 4. Write the failing test first

Every fix needs a regression test using the **real utterance from the trace**, added before the fix.
Pick the suite that matches:

| Suite | Covers |
|---|---|
| `harness.js` | commands on a page (`--blank` for an empty tab) |
| `compose-harness.js` | email field routing, scripted as conversations |
| `dictation-harness.js` | content vs command while writing |
| `multistep-harness.js` | chained commands vs single actions containing "and" |
| `ordinal-harness.js` | positional targeting |

Fixtures live in `test/fixtures.js`. If a gap fits no existing suite, add cases to the closest one
rather than starting a new file, unless the failure is a genuinely new *kind*.

Run it and watch it fail before fixing. A test that passes before the fix is testing nothing.

## 5. Fix, then prove it

```sh
cd test
for h in harness.js compose-harness.js dictation-harness.js multistep-harness.js ordinal-harness.js; do
  node --env-file=../.env $h
done
node --env-file=../.env harness.js --blank
```

All must pass. These call the live API — roughly a cent for the full set — so run them once at the end,
not after each edit.

When editing with a script, **assert the anchor matched**. Silent no-op replacements have shipped
broken fixes here before:

```python
def sub(s, old, new, label):
    if old not in s: raise SystemExit(f"FAILED [{label}]")
    return s.replace(old, new)
```

## 6. Report honestly

Tell the user:

- which gaps you fixed, and what was actually wrong — name the file and the cause
- which you deliberately **didn't** fix, and why (transcription errors, side conversation, one-offs)
- anything you changed that they might disagree with, especially a behavior decision like a
  confirmation threshold
- the test counts

Then commit, and remind them to **reload the extension** — changes don't take effect until they do,
and a manifest change may prompt for new permissions.

If a session had no gaps, say that plainly and stop. Don't manufacture work.
