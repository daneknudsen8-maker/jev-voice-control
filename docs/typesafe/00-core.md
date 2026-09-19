# TypeSafe / Jev — core reference

Condensed from https://docs.typesafe.ai on 2026-09-19 (model `jev-1.13.0`, Python SDK docs current, JS SDK v0.6.0).
This file is the one to read first. Full local mirror in `reference/`. **You should not need to fetch the live docs.**

## What it is

Jev is a **System One model**: it returns *typed judgments with calibrated probabilities*, not text.
You send `state` (the content) plus a map of named `questions`; you get back one typed `answer` per question.
There is no generation, no reasoning trace, no tool loop. Code owns the workflow; Jev supplies
semantic judgment where ordinary code can't. ~100 ms typical latency.

## Endpoint

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

`GET /v1/models` lists model names/aliases available to the account.

### Request

| Field | Required | Type | Notes |
|---|---|---|---|
| `state` | yes | `string \| object \| array` | The content to evaluate. Text only. |
| `model` | yes | `string` | `jev-latest`, or pin `jev-1.13.0`. |
| `questions` | yes | `map<string, Question>` | Keys are ids **you** choose. |

**Question ids are never sent to the model.** They only key the response. Put the full meaning in `instructions`.

### Response

```json
{
  "model": "jev-1.13.0",
  "answers": { "<your_id>": { "type": "...", ... } },
  "usage": { "input_tokens": 307, "output_tokens": 23 }
}
```

## The three primitives

### Noul — "is this true?"

```json
{ "type": "noul",
  "instructions": "Does the customer request a refund?",
  "criteria": { "true": "...", "false": "..." } }
```
`criteria` optional. Answer: `{ "type": "noul", "noul": 0.95 }` — probability of **yes**, 0→1.

**Noul has no `confidence` field.** 0.5 means yes and no are equally likely — it does *not* mean "medium
intensity". If you want intensity, use a Score. Phrase so that high = yes; a Noul whose `true` means "no"
performs measurably worse.

### Choice — "which one of these?"

```json
{ "type": "choice",
  "instructions": "Which team should handle this?",
  "criteria": { "billing": "Payments, invoicing, refunds",
                "technical": "Bugs, outages",
                "other": null } }
```
`criteria` is a map option → description; `null` when the name speaks for itself. **Up to 255 options.**
Options cost only a few tokens each, so pass the full list, not a shortlist. Add `other` /
`none_of_the_above` whenever the list may not cover every input.

Answer:
```json
{ "type": "choice", "choice": "technical",
  "probabilities": { "billing": 0.08, "technical": 0.85, "other": 0.07 },
  "confidence": 0.82 }
```
`probabilities` sums to 1. `choice` is simply the argmax.

### Score — "where on this scale?"

```json
{ "type": "score",
  "instructions": "How severe is the reported issue?",
  "criteria": ["Cosmetic; no impact",
               "Degraded feature, workaround exists",
               "Blocking; no workaround"] }
```
`criteria` is an **ordered array, 2 to 10 levels**. Level number = array index, starting at 0.

Answer:
```json
{ "type": "score", "score": 1.3,
  "legend": { "0": "Cosmetic; no impact", "1": "...", "2": "..." },
  "probabilities": { "0": 0.0, "1": 0.7, "2": 0.3 },
  "confidence": 0.54 }
```
`score` is the probability-weighted mean of level indices (0·0.0 + 1·0.7 + 2·0.3 = 1.3), so it lands
*between* levels. **Different distributions give the same score** — 1.0 can be all-on-level-1 or a 50/50
split of levels 0 and 2. Read `probabilities` alongside it.

Scales of different lengths are not comparable: normalize by `len(criteria) - 1` before combining.

#### Writing levels
- Describe **situations, not degrees**. "Degraded feature, workaround exists" works; "moderately severe" doesn't.
- Each level is judged **independently**; the model sees neither the index nor the neighbours. Numeric-only
  levels (`["0","1","2"]`) perform badly — a report that scores 0.0/conf 1.0 with descriptions scored
  0.57/conf 0.35 with bare numbers.
- **One dimension per question.** "punctual and smart and experienced" is three questions.
- Give a rare extreme its own level ("abusive or threatening" above "very angry") if you act on it differently.

## Choosing a type

| Answer shape | Use | Maps onto |
|---|---|---|
| One of a fixed unordered set | Choice | a `switch` |
| Position on a describable spectrum | Score | a threshold / a ranking |
| Yes or no | Noul | an `if` |

If two fit, pick the one your code can act on directly.

## Structure is allowed everywhere

`instructions`, each Choice option description, each Score level, and Noul `criteria.true`/`.false` all accept
`string | object | array | null` (the SDKs call this `EntryType`). Start with strings; reach for objects when
a description needs several kinds of guidance:

```json
"criteria": {
  "billing": { "what": "Charges, invoices, refunds",
               "not_for": "Order tracking",
               "examples": ["I was charged twice"] } }
```
Field names (`what`, `not_for`, `examples`, `question`, `focus`) are **yours** — nothing is reserved. The model
sees the key names as well as the values, so name them meaningfully.

## Pointing at part of the state

When `state` is an object, name the field in the instruction with a **backticked dot/index path**:

```python
"instructions": "Does `ticket.messages[0].text` request a refund?"
```
This is the single cheapest accuracy win on structured state.

## Ask everything in one request

Questions in one request are evaluated **in parallel against the same state**, and they cannot see each
other's answers. Adding questions barely moves latency and costs only the extra question tokens.

**Send every question your code might need, including speculative ones**, and let code ignore the
irrelevant answers. Batching 13 questions into one call measured **12.2× cheaper and 10.0× faster** than 13
calls, with identical answers. Coding agents habitually get this wrong — one question per call is the
anti-pattern.

A **second request** is justified only when code cannot build it without the first answer: to fetch new
evidence, to construct new state, or to decide the next options. Otherwise, one request.

## Confidence

Only on **Choice and Score**. Derived from how peaked `probabilities` is — a single spike is high confidence,
a flat spread is low. You always get the raw `probabilities` too, so you can compute your own measure.

Low confidence on a Choice ≈ no clear winner. On a Score ≈ levels overlap, the question measures more than
one thing, or the state doesn't say enough.

Gate on it, with **thresholds scaled to the stakes of each action**, not one global number:

```python
if action.confidence < 0.5:          route_to_human()      # genuinely unsure
elif action.choice == "check_balance":  show_balance()     # low stakes
elif action.choice == "approve_transfer":
    if action.confidence > 0.9:      confirm_then_execute() # high stakes
    else:                            ask_user_to_confirm()
```
Confidence describes the answer's distribution — **not** correctness, and not permission to act. Several
acceptable alternatives also spread probability, so low confidence on a harmless preference is fine.
Ignore confidence on speculative branches you didn't take. Tune thresholds on your own data.

## Limits and cost (`jev-1.13.0`)

| | |
|---|---|
| Price | **$42 / Btok input** ($0.042 per Mtok). **Output tokens are free.** |
| Rate limits | 250,000 tokens/sec, 1,200 requests/min (adjusting dynamically; 429 on either) |
| Context | 64k tokens per request total; 32k for `state` + the single longest question |
| Input | Text only — string, JSON object, or array of text. No image/audio/video. |
| Language | English best; other languages incl. CJK accepted but less accurate |

Not fine-tunable. You adapt it through `state`, `instructions`, and `criteria` — same weights for everyone.
Not trained on customer requests. ZDR available for enterprise.

## Errors

| Status | Meaning |
|---|---|
| 401 | Missing/invalid key |
| 422 | Validation failed; body names the offending field |
| 429 | Rate limited — back off and retry |
| 529 | Overloaded — retry after a short delay |

SDKs retry 429/529 with exponential backoff by default and honor `retry-after`.

## Aliases

`jev-latest` → `jev-1.13.0` (stable, SDK default). `jev-preview` → newest build, currently the same.
Aliases move without warning. The response's `model` field always reports the versioned id that answered —
log it. **If you tuned confidence thresholds against a version, pin that version.**
