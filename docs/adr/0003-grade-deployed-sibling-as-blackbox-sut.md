# ADR-0003: Grade the deployed product-feedback sibling as a black-box subject-under-test

- **Status:** Accepted
- **Date:** 2026-05-30
- **Workflow:** `Portfolio - LLM Eval Harness API` (`workflows/sdk/llm-eval-harness.workflow.js`, v0.3.0, live id `IhmmthDFMKdDbgvp`)
- **Related:** [ADR-0001](0001-hybrid-deterministic-and-llm-judge-scoring.md) (hybrid deterministic + LLM-as-judge,
  stub-default), [ADR-0002](0002-deploy-via-rest-api-without-mcp.md) (deploy via REST without MCP), and
  [eval-plan.md](../eval-plan.md) (the Layer-1/Layer-2 recursion; the golden set lists a
  `feedback-bug-negative` case with SUT mode `workflow (product-feedback)`).

## Context

The eval plan always intended a `sutMode: "workflow"` that grades a sibling portfolio workflow as a
**subject-under-test (SUT)** — the "connected projects" claim that turns four demos into a system.
Through v0.2.0 the SUT was a deterministic **stub** (echo, with a `HALLUCINATE` trapdoor); only the
**judge** had been wired to a live model. v0.3.0 builds the live SUT against the deployed
`product-feedback-intelligence` API (`6Gc3wmri0tJre07B`).

The design question is **how** the harness should reach the sibling. Two honest options exist, and the
choice changes what the eval actually proves:

1. **Import / re-execute the sibling's code** (call its SDK module, or run a private copy of its
   classifier in-process). Fully offline and deterministic, but it grades a *copy of the source*, not
   the thing users hit. It would let the harness narrate "I evaluate product-feedback" while never
   touching the deployed system — exactly the kind of dishonesty the sibling ADRs warned against.
2. **Call the deployed sibling over its real HTTP endpoint as a black box** — POST the same request
   body a real client sends to `POST /webhook/portfolio/product-feedback-intelligence`, read back the
   structured response, and grade `response.theme`. This tests the *deployed system* end to end
   (webhook, normalization, classifier, confidence gate, response shaping), at the cost of needing the
   sibling **active** and tolerating its runtime failures.

## Decision

**Option 2 — grade the deployed sibling as a black box over its real webhook.** A visual IF gate
(`SUT Mode = Workflow?`) mirrors the v0.2.0 judge-gate idiom and routes `sutMode: "workflow"` to a
per-case **fan-out** -> an **httpRequest** node that POSTs each golden case's feedback object to the
product-feedback webhook -> a **parse** node that extracts `response.theme` (plus `sentiment` /
`urgency`) as the case's **actual output**. The deterministic assertion is an **exact-match**: the
extracted `theme` must equal the case's `expected` theme (product-feedback's own taxonomy: `bug`,
`feature_request`, `usability`, `performance`, `pricing`, `praise`, `churn_risk`, `other`). The optional
Ollama judge (ADR-0001) can still score the subjective quality of the classification when
`judgeSource: "ollama"`, but the connected eval's pass/fail is the deterministic theme match.

Three properties make this safe and honest:

- **Black box, not a code import.** The harness knows only the public request/response contract, so a
  green run is genuine evidence the *deployed* sibling behaves — "tests the deployed system", not a
  re-run of a copied function.
- **Activation is required and explicit.** The sibling must be **active** for its webhook to answer;
  `verify:connected` activates `6Gc3wmri0tJre07B` as its first step and leaves it active. (The harness
  runs inside the n8n container, so it reaches the sibling at the container-local `localhost:5678`; the
  URL is per-request overridable to `host.docker.internal` or a remote n8n if needed.)
- **Failure is non-fatal and never a silent pass.** The httpRequest node uses
  `onError: continueRegularOutput`; if the sibling is unreachable, inactive, or returns a non-2xx /
  themeless body, the parse node marks the case `sutSource: "error"` with an empty output, so the
  deterministic exact-match **fails** (`passed = false`) without crashing the run. A broken sibling
  withholds a pass — it can never silently pass.

The **stub SUT stays the default** everywhere CI touches: `verify:static` / `verify:json` /
`verify:live` exercise only the stub (the eval-plan's offline, reproducible Layer-2 discipline). The
live connected eval is a separate, **Layer-1**, non-CI activity under `npm run verify:connected`
(it needs the live sibling), exactly as the live judge lives under `verify:judge`.

### Why not Option 1 (import / re-execute the sibling's code)
It grades a *copy of the source*, not the deployed system, while letting the project claim it
"evaluates product-feedback." That is the dishonest framing the portfolio explicitly avoids: an eval
harness must not narrate offline plumbing as live evidence. (Determinism is not lost by choosing the
black box — the connected eval simply moves to the non-CI lane, and CI keeps the deterministic stub.)

## Consequences

**Positive**
- The "connected projects" claim is now real: the harness grades the **deployed** product-feedback API
  over its public contract and reports the per-case `theme` vs `expected` table + pass-rate.
- The black-box boundary keeps the two repos decoupled — no shared code, no import coupling; the sibling
  can evolve as long as its response contract holds.
- Graceful, surfaced degradation (an unreachable sibling is a `passed=false`, not a 500) matches the
  harness's "never silently pass" invariant.

**Negative / accepted trade-offs**
- The connected eval is **not** offline: it needs the sibling active and a running n8n, so it stays out
  of CI / `verify:live` (the stub remains the CI default).
- It grades whatever classifier the sibling currently runs. product-feedback's webhook defaults to its
  **deterministic stub** classifier (`classifierSource: "stub"`), so the connected slice is currently a
  deterministic black-box check; pointing the sibling at its live Ollama classifier would make the same
  slice non-deterministic (and a legitimate future calibration target).
- A theme-taxonomy drift in the sibling would surface as connected-eval failures — which is the eval
  working, but it couples the golden labels to the sibling's enum.

## Evidence

v0.3.0 deployed live as workflow `IhmmthDFMKdDbgvp` (**26 nodes**, active) on 2026-05-30. The new
4-node SUT branch (`SUT Mode = Workflow?` -> `Fan Out SUT Cases` -> `Call Product-Feedback (SUT)` ->
`Parse Product-Feedback (SUT)`) was added between validation and the deterministic assertions; both SUT
branches fan in to `Run Deterministic Assertions`, so the judge -> aggregate -> audit -> response tail
is unchanged. `npm run verify:connected` activated product-feedback (`6Gc3wmri0tJre07B`) and graded it
live over the 6-case slice (`feedback-bug-negative`, `feedback-feature-request`, `feedback-praise`,
`feedback-pricing`, `feedback-performance`, `feedback-usability`): the run returned `sutMode: "workflow"`
and **passRate 1.0** — product-feedback's live classifications matched the expected theme on all six
cases (raw sample: `feedback-bug-negative` -> `{ theme: "bug", sentiment: "negative", urgency: "high",
classifierSource: "stub", redactedEmail: "c***@example.test." }`). A forced unreachable-sibling run
(bad `sutWebhookUrl`) returned **HTTP 200** with `passed: false` and did not crash, confirming the
non-fatal path. The stub-default Layer-2 suite (`verify:live`, 30 assertions) and the live judge
(`verify:judge`, agreement 1.0 / `judgeTrust: high`) remained green.

## Honest framing for the résumé / interview

Narrate this as *"the eval harness grades a **deployed** sibling workflow as a black-box
subject-under-test over its real API — honest 'tests the deployed system', with graceful non-fatal
failure when the sibling is down — while the reproducible CI suite still runs a deterministic stub."*
The differentiation is the **connected, deployed-system evaluation** and the **never-silently-pass**
degradation, not "I called another workflow."
