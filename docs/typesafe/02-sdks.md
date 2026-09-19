# SDK reference (Python + JavaScript)

Both SDKs read **`TYPESAFE_API_KEY`** from the environment automatically. Both default to `jev-latest`.
Both retry 429/5xx with backoff and honor `retry-after` out of the box.

## Environment variables (identical in both)

| Variable | Configures | Default |
|---|---|---|
| `TYPESAFE_API_KEY` | API key (**required**) | — |
| `TYPESAFE_BASE_URL` | API root | `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | Default model | `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | Log level: `debug\|info\|warning\|error\|off` | unset (JS: `warn`) |

---

# Python — `typesafe-sdk`

```sh
uv add typesafe-sdk     # or: pip install typesafe-sdk
```

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient() as client:
    result = client.system_one(
        state={"ticket": "I was charged twice. Please fix this ASAP."},
        questions={
            "billing": Noul(instructions="Is `ticket` about billing?"),
            "tone": Choice(
                instructions="What is the customer's tone?",
                criteria={"calm": None, "frustrated": None, "angry": None},
            ),
            "urgency": Score(
                instructions="How urgent is this ticket?",
                criteria=["can wait", "this week", "today"],
            ),
        },
    )

result.answers["tone"].choice        # by id, any type
result.nouls["billing"].noul         # type-filtered accessors
result.choices["tone"].confidence
result.scores["urgency"].score
result.request_id
result.raw_http_response.json()      # escape hatch
```

`AsyncTypeSafeClient` is the same API with `await`, used as `async with`.

**Note:** in the Python SDK, Score `probabilities` and `legend` are keyed by **int**; over raw HTTP they are
**strings**.

### Typed responses

```python
from typesafe_sdk import Noul, NoulAnswer, SystemOneResponse, TypeSafeClient

class BillingResponse(SystemOneResponse):
    billing: NoulAnswer

result = client.system_one(state, questions, response_model=BillingResponse)
result.billing.noul          # typed attribute; == result.nouls["billing"]
```
A plain pydantic `BaseModel` works too, if you don't want to inherit.

### Config, retries, errors

```python
client = TypeSafeClient(model="jev-1.13.0")
client = TypeSafeClient(retry=RetryPolicy(max_retries=3, backoff_max=0.2, timeout=1.0))
client.system_one(state, questions, retry=RetryPolicy(...))   # per-call override
```

`RetryPolicy` defaults: `max_retries=2`, `backoff_initial=0.5`, `backoff_max=5.0`, `backoff_jitter=0.25`,
`http_statuses={408, 429, 500-599}`, `respect_retry_after=True`, `timeout=30.0`.
Per-operation HTTP timeout default is `10.0`.

```python
from typesafe_sdk import TypeSafeAPIError
try:
    client.system_one(state, questions)
except TypeSafeAPIError as error:
    print(error.status, error.request_id)
```

Exception hierarchy: `TypeSafeError` → `TypeSafeAPIError` → `TypeSafeAuthenticationError`,
`TypeSafeBadRequestError`, `TypeSafeNotFoundError`, `TypeSafePermissionDeniedError`,
`TypeSafeRateLimitError`, `TypeSafeUnprocessableEntityError`, `TypeSafeInternalServerError`,
plus `TypeSafeAPIConnectionError`, `TypeSafeAPITimeoutError`, `TypeSafeAPIResponseValidationError`.

### Logging
Logs to the `typesafe_sdk` logger. `info` = one line per request; `debug` = headers and bodies.
Auth headers/cookies/anything containing `token` or `secret` are redacted — **bodies are not.**

### Forward compatibility
`extra_body={"beam_width": 4}` sends fields the SDK version predates. Raw dicts work in place of typed
questions: `{"billing": {"type": "noul", "instructions": "...", "weight": 2}}`. Unknown answer kinds are
skipped with a warning — reach them via `raw_http_response`.

---

# JavaScript / TypeScript — `@typesafe-ai/sdk`

Node 20+. Ships ESM, CJS, and type declarations.

```sh
npm install @typesafe-ai/sdk
```

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

const response = await client.systemOne({
  state: { ticket: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is this ticket about?", {
      billing: null, technical: null, other: null,
    }),
    isUrgent: noul("Does `ticket` convey urgency?"),
    severity: score("How severe is this?", ["minor", "major", "blocking"]),
  },
});

response.answers.category.choice;       // answer types inferred from the questions
response.answers.isUrgent.noul;
response.model;
response.usage;
```

Helper signatures:
- `choice(instructions, criteria)` — criteria: labels → descriptions, or `null`
- `noul(instructions?, criteria?)` — criteria: `{ true?, false? }`
- `score(instructions, criteria)` — ordered array, ≥2 entries, entries may be `null`

### Client config (`TypeSafeClientConfig`)

| Option | Falls back to |
|---|---|
| `apiKey` | `TYPESAFE_API_KEY` |
| `baseURL` | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` |
| `defaultModel` | `TYPESAFE_DEFAULT_MODEL`, then `jev-latest` |
| `logLevel` | `TYPESAFE_LOG_LEVEL`, then `warn` |
| `defaultHeaders`, `fetch`, `logger`, `retry` | — |
| `dangerouslyAllowBrowser` | `false` |

**`dangerouslyAllowBrowser` exposes your API key to every visitor.** Leave it off. Call TypeSafe from a
server route and pass results to the client.

Errors: `TypeSafeError` → `APIError` → `AuthenticationError`, `BadRequestError`, `NotFoundError`,
`PermissionDeniedError`, `RateLimitError`, `UnprocessableEntityError`, `InternalServerError`,
plus `APIConnectionError`, `APITimeoutError`, `APIUserAbortError`.
