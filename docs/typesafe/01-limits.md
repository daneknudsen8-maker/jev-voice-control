# Jev 1.13 — known failure modes

From the official "jaggedness" page (reviewed 2026-09-17). **Read this before debugging a bad answer.**
Most surprising results are one of these nine, not a bug in your code.

Jev is fast, calibrated, and good at common-sense judgment. It is **literal**, **bad at numbers**, and
degrades with **indirection** and **irrelevant context**.

### 1. Literal reading
It answers the question you *wrote*, not the one you meant. Scoping words, negations and implied
conditions are read at face value.
→ State the exact condition in `instructions`. Put boundary cases in `criteria`. **When you look at a wrong
answer and find yourself explaining what you really meant, that explanation is the missing half of the
instruction.** Where interpretation is unavoidable, split into two literal questions and combine in code.

### 2. Math and numbers
Not a calculator. Keep all arithmetic in code.
- **Counting is unreliable** — characters, occurrences, list items. Error grows with the count. Instead,
  iterate in code and ask one Noul per item, then sum the booleans yourself.
- **Numeric representations underperform semantic ones.** Colors by hex < colors by name. Assembly <
  high-level source. Convert to a name or bucket in code first.
- **Never interpolate a Score to recover a magnitude.** Score levels are not numerically calibrated. A
  threshold check on `score` is fine; reconstructing "the actual number" between two levels is not.

### 3. Dates and times
Read as text, not as ordered quantities. Ordering, differences, and "is it inside this window" are all
unreliable — worse with mixed formats, relative references, and quarter/settlement boundaries.
→ Split it: **extraction is a judgment, arithmetic is not.** Each date part is a small closed set (12 months,
31 days), so extract with a Choice per part — including an explicit "not stated" option — then assemble and
compare in code. See the date extraction cookbook.

### 4. Indirection
Double negatives, properties-of-properties, and multi-hop reasoning cost accuracy.
→ Write instructions as directly as possible; name the relevant state by path.

### 5. Large state full of irrelevant detail
Accuracy falls as unrelated content grows — **context rot**. It also makes wrong answers hard to diagnose.
→ Retrieve and filter in code first; send only the fields the question needs. If you can't filter up front,
use a Noul to screen for relevance.

### 6. Adversarial content
**State is data, and Jev does not treat it as hostile by default.** Injected instructions, misleading
framing, or text arguing for its own classification can move the answer.
→ Be explicit in criteria; test edge cases before exposing it to users. (Relevant whenever state contains
anything user-submitted or retrieved.)

### 7. Contradictory instructions and criteria
If `instructions` and `criteria` pull in different directions the model gets confused — e.g. a Noul whose
`true` maps to "no".
→ Treat criteria as an extension of the instruction. Aim for wording an average person reads unambiguously.

### 8. Structural invariants do not hold
Jev is highly self-consistent on semantically similar inputs, but **do not assume arithmetic identities
between separate questions.**

Same judgment as Noul vs. as a yes/no Choice, on "I'm not happy with the fit. What are my options?":

| Noul | Choice `yes` | Choice `no` | Choice conf |
|---|---|---|---|
| 0.22 | 0.01 | 0.99 | 0.97 |

A question and its negation as two Nouls, on a double-charge ticket:

| `refund` | `not_refund` | sum |
|---|---|---|
| 0.72 | 0.47 | **1.19** |

→ Never carry a threshold tuned on a Noul over to a Choice. `P(x)` and `1 − P(not x)` are not
interchangeable. **A Choice is relative** (which option wins); **a Noul is absolute** (and can be low for
every option). Using both deliberately is a real technique — Choice to rank, Noul to decide whether to act
at all.

### 9. Generation
Not trained to generate text. Chaining Choices to spell something out works badly and is slow.
→ When the answer space is bounded, make extraction a **Choice over candidates** you found with regex, a
parser, or a generative model. For actual text generation, use a different model.

---

## The short version

Avoid:
- asking the model something code can compute exactly
- hiding several judgments inside one question
- System Two tasks — anything needing layers of indirection
- putting more in `state` than the question needs
