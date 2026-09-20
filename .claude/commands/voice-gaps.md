---
description: Analyze the most recent voice session and fix the commands that should have worked
---

Review the most recent voice-control session and implement fixes for the gaps.

Follow the full procedure in `.claude/skills/voice-gaps/SKILL.md`. In brief:

1. **Read the session.** `cd test && node session.js` (add `--json` for every candidate element,
   `--n 2` for the previous session). If the trace is empty, say so — the extension may not have been
   reloaded since tracing was added, or the proxy isn't running. Don't invent an analysis.

2. **Only `gaps` are yours to fix.** `worked`, `refused by design` and `noise ignored` are the system
   behaving correctly. A voice tool hears side conversation constantly; ignoring it is not a failure.

3. **Judge each gap before fixing it.** Speech-recognition errors can't be fixed downstream. One-off
   phrasings usually aren't worth design work. Repeated failures are.

4. **Locate the bug with the confidences.** Jev confident and right but nothing happened means the
   plumbing is at fault — which has been true of most failures in this project. Jev confident and
   wrong means the question wording is. For a missed click, check the candidate list: element absent
   means fix ranking in `extension/content.js`, element present means fix the target question in
   `extension/commands.js`. Opposite fixes.

5. **Prefer code over prompt** for anything with one right answer — position, counting, dates, exact
   phrases, state. Jev is documented as unreliable at all of them (`docs/typesafe/01-limits.md`).
   Never ask it to generate; it selects from what code enumerated.

6. **Write the failing regression test first**, using the real utterance from the trace. Then fix.
   Then run every suite:

   ```sh
   cd test
   for h in harness.js compose-harness.js dictation-harness.js multistep-harness.js ordinal-harness.js; do
     node --env-file=../.env $h
   done
   node --env-file=../.env harness.js --blank
   ```

7. **Report honestly**: what you fixed and why it was broken, what you deliberately left alone, any
   behavior decision the user might disagree with. Commit, and remind them to reload the extension.

$ARGUMENTS
