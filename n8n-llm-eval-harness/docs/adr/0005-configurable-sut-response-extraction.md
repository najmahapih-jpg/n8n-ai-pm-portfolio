# ADR-0005: Configurable SUT response extraction (a per-request `sutExtract` dot-path)

- **Status:** Accepted
- **Date:** 2026-05-31
- **Workflow:** `Portfolio - LLM Eval Harness API` (`workflows/sdk/llm-eval-harness.workflow.js`, v0.6.0, live id `IhmmthDFMKdDbgvp`)
- **Related:** [ADR-0003](0003-grade-deployed-sibling-as-blackbox-sut.md) (grade a deployed sibling as a
  black-box SUT — the `sutMode:"workflow"` path this ADR generalizes), [ADR-0001](0001-hybrid-deterministic-and-llm-judge-scoring.md)
  (hybrid deterministic + LLM-as-judge, stub-default), and [eval-plan.md](../eval-plan.md).

## Context

ADR-0003 wired `sutMode:"workflow"` so the harness grades a **deployed sibling** as a black-box
subject-under-test over its real webhook. That first sibling was **product-feedback**, which returns a
classification object whose verdict field is `theme`. The parse node (`Parse Product-Feedback (SUT)`)
read `response.theme` as each row's **actual output** and exact-matched it against the golden `expected`.

That extraction was **hardcoded to product-feedback's response shape**. The coupling was invisible until
a *second*, differently-shaped sibling needed grading: the **RAG knowledge assistant** (`jZ5Xfml8jbKexYqf`),
whose webhook returns `{ ok, abstained, answer, citations, ... }` — a top-level boolean `abstained`, and
**no `theme` at all**. Pointing `sutMode:"workflow"` at the RAG assistant made the parse node find no
`theme`, emit an empty output, and mark every case `sutSource:"error"` → a false `passRate 0`. The harness
could not grade an arbitrary workflow SUT; it could grade exactly the one SUT it was built against.

The eval-plan always framed the harness as a general grader of "connected" portfolio workflows. A grader
whose output extraction is welded to the first product's response field is not general — it is a
product-feedback test wearing a harness costume. The extraction must be **decoupled from any single SUT's
response shape**.

## Decision

Add a per-request **`sutExtract`** config — a **dot-path** string (default `"response.theme"`) applied to
the SUT's HTTP response to produce each row's **actual output**. The existing deterministic assertions then
grade that output against the golden `expected`, completely unchanged.

- **`Normalize Eval Request`** parses `body.sutExtract` (a trimmed string), defaults it to `"response.theme"`,
  and threads it onto `runtime.sutExtract`. Anything non-string falls back to the default.
- **The workflow-SUT parse node** (renamed `Parse Product-Feedback (SUT)` → **`Parse Workflow SUT`** to
  reflect that it is no longer product-feedback-specific) walks the configured dot-path over each SUT
  response to read the row's output. The walk is **wrapper-tolerant**: it tries the literal path on the raw
  HTTP JSON; if the leading segment is `response` and that misses, it retries against both the raw object and
  an unwrapped `{ response: {...} }` body. This makes the default `"response.theme"` resolve identically
  whether the sibling returns a bare `{ theme, ... }` (product-feedback's `responseMode:responseNode`) or a
  `{ response: { theme } }` wrapper — i.e. **the product-feedback path is byte-for-byte unchanged**. A
  top-level path like `"abstained"` resolves against the RAG assistant's bare `{ abstained, ... }`.
- **Value coercion is consistent with how `expected` is compared.** The deterministic exact-match compares
  `String(output) === String(expected)`. The extractor therefore coerces the extracted value to a comparable
  string the same way: a boolean `false`/`true` becomes `"false"`/`"true"`, a number its decimal string, a
  string itself, and an object/array its JSON form. So a golden `expected:"false"` grading the RAG assistant's
  `abstained:false` matches exactly — the harness grades the abstention decision as a black box.
- **A missing / unextractable path is honest, never a silent pass.** If the dot-path resolves to
  `undefined`/`null` (wrong field, unreachable sibling, error body), the row is marked `sutSource:"error"`
  with an empty output, so the deterministic exact-match **fails** (`passed=false`) — exactly the
  never-silently-pass contract ADR-0003 established. The `onError:continueRegularOutput` on the HTTP node is
  unchanged, so an unreachable sibling is still non-fatal.

**Backward-compatibility is the headline property.** The default `"response.theme"` keeps product-feedback
grading **identical** — `verify:connected` (the live product-feedback slice) must stay green with no request
change, proving the refactor is a pure generalization. The reproducible **stub** default is untouched: this
ADR only affects the live `sutMode:"workflow"` extraction path; `sutMode:"stub"` (the CI default) and
`sutMode:"model"` are unchanged, so `verify:static`/`json`/`live`/`bench` are unaffected.

### Scope: single dot-path in v0.6.0

v0.6.0 ships **one** single dot-path per request — enough to grade a scalar verdict field (`theme`,
`abstained`, any single nested value). Richer extraction — array length (`citations.length`), multi-field
composition, or a transform expression — is a **deliberate future extension**, noted here so the boundary is
explicit and not mistaken for an oversight. A single dot-path covers the two real connected SUTs (A grading
product-feedback's `theme` and the RAG assistant's `abstained`) and keeps the mechanism small and auditable.

### Why a dot-path (not a code import or a bespoke parser per SUT)

- A **per-SUT parse node** would re-introduce exactly the coupling this ADR removes: a third sibling would
  need a third node. A single configurable path scales to N SUTs with zero graph changes.
- A **dot-path** is the smallest config that decouples extraction from shape: it is declarative, lives in the
  request body next to `sutMode`/`sutWebhookUrl`, and needs no code-eval (no `eval`, no injected expression),
  so it adds no execution-surface risk.
- It preserves the **black-box** boundary from ADR-0003: the harness still only knows the public response
  contract; `sutExtract` just says *which public field is the verdict* for this SUT.

## Consequences

**Positive**
- The harness now grades **arbitrary differently-shaped workflow SUTs** — product-feedback (`response.theme`)
  and the RAG assistant (`abstained`) from the *same* code, selected per request. The "connected portfolio"
  claim is now real across more than one sibling.
- Backward-compatible by construction: the default path reproduces product-feedback grading exactly, so the
  generalization carries zero behavioural change for existing callers (`verify:connected` stays green).
- The never-silently-pass invariant is preserved: a wrong/missing path is `passed=false`, not a crash and not
  a fabricated pass.

**Negative / accepted trade-offs**
- A single dot-path cannot express array-length or multi-field verdicts (deferred above); a SUT whose verdict
  is not a single addressable field is not yet gradable via `sutMode:"workflow"`.
- The golden author must know the SUT's response contract well enough to name the verdict field (e.g.
  `sutExtract:"abstained"`). This is intentional — it is the black-box contract, surfaced as config.
- Like ADR-0003, the connected-RAG slice is **non-CI** (needs both A and the RAG sibling active); it runs under
  `verify:connected-rag`, alongside `verify:connected`.

## Evidence

v0.6.0 renames the workflow-SUT parse node to `Parse Workflow SUT` and generalizes its extraction to the
`runtime.sutExtract` dot-path; **no node was added or removed (node floor stays 30)**. `Normalize Eval Request`
threads `runtime.sutExtract` (default `"response.theme"`). New `fixtures/golden/connected-rag.json` grades the
RAG assistant's **abstention** as a black box (`rag-in-corpus` → `abstained:false` → `expected:"false"`;
`rag-out-of-corpus` → `abstained:true` → `expected:"true"`) with `sutMode:"workflow"`, `sutExtract:"abstained"`,
and the RAG webhook. New `npm run verify:connected-rag` (live, non-CI) POSTs that slice and asserts A now grades
the RAG assistant correctly (**passRate 1.0**). `verify:connected` (product-feedback, **default**
`sutExtract:"response.theme"`) stayed green — backward-compat proven. The stub-default Layer-2 suite
(`verify:live`), the live judge (`verify:judge`), and the bench (`verify:bench`) remained green; the other five
workflow ids were untouched.

## Honest framing for the résumé / interview

Narrate this as: *"I discovered the harness's SUT output-extraction was **coupled to the first product's
response shape** when I connected a second, differently-shaped product (a RAG assistant returning an
`abstained` flag instead of a `theme`). I refactored the hardcoded `response.theme` read into a configurable
**dot-path** (`sutExtract`), so the same harness now grades arbitrary workflow SUTs as black boxes — with the
default path keeping the original product-feedback grading byte-for-byte identical, and a missing path failing
honestly instead of silently passing."* The differentiation is **recognizing the coupling the moment a second
SUT appeared and decoupling it cleanly** — generalizing a working eval without breaking the one it already
graded — not "I added a config option."
