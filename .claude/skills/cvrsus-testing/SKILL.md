---
name: cvrsus-testing
description: Use before running or writing any Cursus test suite. Covers the spare-port rule, which env vars each suite needs, the fixture-cleanup rule that has already cost real accounts, and the failures that look like bugs but are not.
---

# Running and writing the Cursus suites

There are ~45 suites in `test/`, each `npm run test:<name>`. They run against a
**live server and the real database**, which is why the rules below exist.

## Never run against port 5175

5175 is the default and it is the developer's own server. Start a spare one and
point every command at it:

```
PORT=5199 node server/src/index.js
CKING_URL=http://127.0.0.1:5199 node test/<suite>.mjs
```

`test/helpers.mjs` defaults `BASE` to `http://localhost:5175`, so **`CKING_URL`
must be set on every single command**. Forgetting it silently runs the suite
against the live dev server.

The env var is `PORT`, not `CKING_PORT`.

## Fixture cleanup: delete only what you created, by marker

Every suite mints a run marker — `cking-sec-<base36>`, `cking-demo-<base36>` —
and must delete only rows matching its own. A broad query (`email LIKE
'%example.com'`, or a date range) will eventually take something real. **This
has already destroyed real accounts.**

Deleting a candidate: use `deleteCandidateCompletely(id)` from
`server/src/profiles.js` — it knows the foreign-key graph **and returns the
stored filenames so the caller can unlink them**. A suite that drops the rows
and leaves the files makes `api.test`'s orphan sweep fail on its own litter.

Companies have no equivalent helper; copy the cascade at the foot of
`test/api.test.mjs`.

## Rate limits are per-process and reset on restart

When a suite 429s, **restart the server** — the buckets are in memory. Do not
raise the caps to get past it.

`api.test.mjs` genuinely needs raised limits. Raise only these:

```
RATE_APPLY_MAX RATE_CODE_MAX RATE_VERIFY_MAX RATE_LOGIN_MAX RATE_REGISTER_MAX
```

**Never raise `RATE_CONTACT_MAX`.** `security-check.mjs` loops until the contact
endpoint answers 429, so the cap *is* the loop bound. At 100000 it wrote 161,116
rows into the live database and buried two genuine contact messages. The real
default is 5.

Killing a suite mid-run also orphans the node process — it keeps writing after
the shell is gone. Check `Get-Process node` and stop it by PID.

## Failures that are not bugs

| Symptom | Cause |
|---|---|
| `public-demo-check`: "no results to test against", 5 cascading failures | `PUBLIC_DEMO_MIN_SCORE` defaults to 40 and a keyless box scores below it. Run with `PUBLIC_DEMO_MIN_SCORE=1`. Nothing is broken — `considered: 1` proves retrieval ran. |
| A suite reports 5 failures then a Node assertion about `UV_HANDLE_CLOSING` | Node 24 crashing on exit, after the suite passed. Read the output, not the exit code. |
| `api.test`: "no orphaned files left on disk — _swept" | Another suite quarantined a file. `_swept` is a directory and the server skips directories. |

## Writing a suite

- Assert the **request** as well as the reply when testing a prompt: a rule that
  never reaches the API is a comment.
- Stub the Anthropic API at the fetch layer **before** importing `ai.js` — the
  SDK captures `fetch` when the client is constructed.
- Prefer a value-level assertion over a key-level one. Searching the raw
  response text for a real database value catches a leak that a renamed or
  nested key would hide — that is how `public-demo-check` proves masking.
- A substring search cannot prove a random secret is not derived. Assert the
  known formulas are refused and that repeated draws differ.
- Scope any "nothing is left over" assertion to rows old enough to predate the
  run, or another suite's live fixture will fail it for behaving correctly.
