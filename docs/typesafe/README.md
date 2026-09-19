# TypeSafe / Jev documentation — local copy

Captured from https://docs.typesafe.ai on **2026-09-19**, against model **`jev-1.13.0`**.

**Read these instead of fetching the live docs.** The four distilled files below cover the whole API surface;
together they are ~25KB, versus ~1.1MB for the full mirror and many round-trips over the network.

| File | What's in it | Read when |
|---|---|---|
| [00-core.md](00-core.md) | Endpoint, request/response shapes, all three primitives, confidence, limits, pricing, errors | **Always — start here** |
| [01-limits.md](01-limits.md) | The nine documented failure modes of `jev-1.13` | Before debugging any surprising answer |
| [02-sdks.md](02-sdks.md) | Python + JS SDK usage, config, retries, exceptions, env vars | When writing integration code |
| [03-design-patterns.md](03-design-patterns.md) | Decomposition method, the four patterns, cookbook index | When designing what to ask |

A full local mirror of all 109 doc pages can live in `reference/`, but it is **gitignored** — those pages
are TypeSafe's copyrighted content and are not republished here. The four files above are original
summaries. To rebuild the mirror locally, see "Refreshing this copy" below; filenames mirror URL paths
with `/` → `__`, e.g. `cookbooks__rerank_typesafe.md` = `docs.typesafe.ai/cookbooks/rerank_typesafe`.

## The 60-second version

Jev returns **typed judgments with calibrated probabilities**, not text. Send `state` + named `questions`,
get one typed `answer` per question. Three question types:

- **Noul** → `noul` (0–1 probability of yes). No confidence field.
- **Choice** → `choice` + `probabilities` + `confidence`. Up to 255 options.
- **Score** → `score` (fractional position) + `legend` + `probabilities` + `confidence`. 2–10 ordered levels.

Four rules that matter more than the rest:

1. **Ask every question you might need in ONE request.** Parallel evaluation, ~zero latency cost, 12× cheaper
   than separate calls. One-question-per-call is the classic agent mistake.
2. **Decompose broad judgments into atomic questions**, then weight them in code. Never "rate this pitch";
   ask about market size, feasibility, and differentiation separately.
3. **Keep arithmetic, dates, counting and exact lookups in code.** Jev is bad at all four, by design.
4. **Gate on confidence, with thresholds scaled to the stakes** of each individual action.

## Refreshing this copy

```sh
curl -sL https://docs.typesafe.ai/llms.txt | grep -oE 'https://docs\.typesafe\.ai/[^)]+\.md' | sort -u
```
Then re-fetch and strip the `export function` blocks. Check the live
`model-jaggedness/` page and `models.md` first — those change most often, and pricing and rate limits are
explicitly described as moving.
