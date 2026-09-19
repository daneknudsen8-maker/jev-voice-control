# Designing with TypeSafe — method, patterns, recipes

## The method

Build a **normal software workflow** and insert Jev only where judgment is needed.

1. **Use code wherever code works.** Control flow, rules, arithmetic, lookups, side effects. Deterministic,
   free, debuggable. Avoid agent `while` loops when a workflow expresses the same thing.
2. **Decompose the state.** Send only what the questions need. Don't rely on the model's weights for facts
   your own database holds.
3. **Structure the state.** Nested JSON with descriptive field names; point questions at paths with backticks.
4. **Decompose the questions.** *The most important idea in the docs.* Ask the most explicit, narrow, atomic
   questions you can. Broad questions hide several judgments behind one number; atomic ones expose each
   judgment so you can inspect, tune and weight them separately.
5. **Gate on probability and confidence**, with thresholds set by consequence.
6. **Ask independent questions together**; compose the answers in code.

Worked example — spam detection. Instead of one "is this spam?":
- Does `message.body` ask for a password or login credential?
- Does `message.body` claim an unexpected prize or payment?
- Does `message.subject` or `body` pressure the recipient to act quickly?
- Does the org in `message.sender.display_name` conflict with the domain in `message.sender.email`?
- Does `message.links[0].text` conceal the destination in `message.links[0].url`?

Six inspectable signals you weight in code, instead of one opaque verdict.

## Why the primitives compose

- **Structured** — answers conform to the types you defined; never parse prose.
- **Parallel** — one question's answer is never hidden context for another.
- **Comparable** — outputs sort, threshold, and drive `if` statements.
- **Fast** — ~100 ms, usable on a request path or in a UI.
- **Calibrated** — trained (RLCD) to express honest uncertainty rather than trend overconfident.
- **Self-consistent** — stable across repeated evaluations.

---

## The four core patterns

### Speculative fan-out
Put *every* question your system might need in one call, including ones that only matter on some branches.
Parallel evaluation means near-zero latency cost; extra questions cost only their own tokens.

```python
if category.choice == "bug_report":
    if bug_severity.score > 1.5 and bug_repro.noul > 0.6:
        escalate_to_engineering(ticket_id)
    else:
        add_to_bug_backlog(ticket_id)
elif category.choice == "billing":
    route_to_billing(ticket_id, refund_likely=refund.noul > 0.7)
# frustration is read regardless of category; shipping_issue is simply never read
```

### Confidence-gated routing
The answer says *what*; confidence says *whether to act*. One floor for "genuinely unsure", then
per-action thresholds scaled to the stakes. See `00-core.md`.

### Composite scoring
Score each dimension independently, normalize each by `len(criteria) - 1`, then weight in code:

```python
py   = answers["python_depth"].score / 4
lead = answers["team_leadership"].score / 4
arch = answers["system_design"].score / 4

ic_score = 0.40*py + 0.10*lead + 0.40*arch + 0.10*general   # senior IC
em_score = 0.15*py + 0.40*lead + 0.20*arch + 0.25*general   # eng manager
```
The weights live in your code: visible, adjustable, and **changing one doesn't require re-running inference**
as long as the evidence and question meanings are unchanged. Raw judgments stay reusable; policy stays explicit.

Weighted sums suit *compensating* preferences. An "any serious violation blocks" rule is **not** a weighted
sum — keep that as separate conditions.

### Intent routing
Jev as a fast cheap classifier in front of expensive handlers: deterministic code, a specialist LLM, or a
human. Only the requests that need the expensive path take it.

---

## Recipe index

Each cookbook is mirrored in full under `reference/cookbooks__*.md`. What each one teaches:

| Cookbook | Technique worth stealing |
|---|---|
| `parallel_questions` | Batching 13 questions into one call: **12.2× cheaper, 10.0× faster**, identical answers |
| `function_calling` | NL request → typed function + closed-set args, confidence-aware |
| `skill_suggestion` | Rank 182 candidates in one request, then re-judge the top 3 properly in a second; Choice to rank + Noul to decide whether to act at all |
| `hierarchical_classification` | Beam search over Choice probabilities down a deep taxonomy |
| `classification_using_confidence` | Low confidence at a leaf → report the *parent* category instead |
| `rerank_typesafe` | One question per query-candidate pair; BM25 top-1 5% → 18%, top-10 38% → 62% |
| `semantic_find` | Score 218 line ids in one Choice; a Noul checks the doc answers at all |
| `classifying_rag_passages` | Screen retrieved passages — drop prompt injections, flag contradictions |
| `citation_check` | Choice on whether quote context supports the claim; confidence flags for review |
| `llm_guardrails` | One request screening in/out messages: hazard Nouls + harm-severity Score |
| `pre_parsed_value_extraction` | Regex finds candidates → Choice selects the right span → code normalizes |
| `date_extraction` | Date parts as Choices over closed sets, incl. "not stated"; assemble in code |
| `sde_cascade` | mini → verify → reasoning cascade: most of a big model's quality, a fraction of cost |
| `entity_alignment` | Score levels *are* the three actions (merge / leave / escalate) — no threshold to fit |
| `autoformat` | Two-request pipeline where the second request's state didn't exist until the first answered |
| `consistency_noul` / `consistency_choice` | Self-consistency measurement; routing uncertain cases to review |
| `autoresearch_feature_discovery` | Jev probabilities as features for a supervised CatBoost model |

---

## Testing and debugging

- Test representative cases and the **resulting application behavior**, not just answers.
- On a failure, separate: missing evidence / model error / code error / service failure. Inspect the exact
  state, questions, answers, and composition.
- **Cookbook thresholds are examples, not universal constants.** Evaluate on your own data.
- Typed output guarantees the *interface*, not the truth.
- Keep credentials server-side. Measure real request budgets, cost, and end-to-end latency.

---

*Note on one figure: the `parallel_questions` cookbook and the docs index both state 12.2× cheaper /
10.0× faster; `primitives.md` still says 11.5× / 9.6×. The cookbook is the authoritative source and is what
this file quotes.*
