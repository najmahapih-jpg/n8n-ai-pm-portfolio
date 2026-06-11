# ADR-0001: Hybrid deterministic + LLM-as-judge scoring, with a calibrated, stub-default judge

- **Status:** Accepted
- **Date:** 2026-05-30
- **Workflow:** `Portfolio - LLM Eval Harness API` (`workflows/sdk/llm-eval-harness.workflow.js`, v0.2.0)
- **Related:** [eval-plan.md](../eval-plan.md); the sibling decisions this builds on —
  `n8n-product-feedback-intelligence/docs/adr/0001-llm-classification-with-deterministic-fallback.md`
  (LLM-with-fallback + stub-default) and the deterministic-first ADRs in `n8n-workflow-as-code` /
  `n8n-lead-intelligence-workflow`.

> **Update (2026-05-30, v0.2.0): implemented + verified live.** The hybrid scorer is now built and
> demonstrated end-to-end. A per-request `judgeSource: "ollama"` routes — via a visual IF gate
> ("Judge Source = Ollama?") — to a per-case fan-out and an HTTP node calling a local `llama3.2:3b`
> (`host.docker.internal:11434/api/chat`, `format: "json"`, `temperature: 0`); a parse node
> schema-validates the four integer 1..5 dimensions and, on invalid or unreachable output, forces the
> deterministic **fallback** (`judgeSource: "fallback"`, null scores, `passed = false`) — a broken or
> off-contract judge never silently passes, and `onError: continueRegularOutput` makes a flaky model
> non-fatal. The deterministic **stub judge stays the default**, so the Layer-2 suite (`verify:live`,
> 30 assertions) remains offline and reproducible. The **judge–human calibration** is real: golden
> cases may carry a `humanLabel` ({passed} and/or {groundednessBand}); the run computes judge–human
> agreement over the labelled slice and sets `judgeTrust = "high"` (≥ 0.8) else `"low"` — surfaced in
> the response, never assumed. Verified 2026-05-30 against the live workflow (id `IhmmthDFMKdDbgvp`,
> 22 nodes, active): `npm run verify:judge` over the 6-case slice returned `judgeSource: "ollama"`,
> **agreement 1.0**, `judgeTrust: "high"`; a forced bad-model run returned `judgeSource: "fallback"`,
> `passed: false` without crashing. (Honest caveat: a tightened prompt — explicitly forbidding scores
> outside 1..5 — was needed because the 3B model initially reached for `0` on egregious hallucinations,
> which the strict schema correctly rejected into the fallback. The schema was **not** weakened; only
> the prompt was clarified. A different/harder slice could legitimately land below 0.8 and report
> `judgeTrust: "low"` — that is the drift guard working, not a failure.)

## Context

This workflow is an **eval harness**: its output *is* a quality judgment about some other AI system.
That inverts the sibling risk. There, an LLM was a *classifier* wrapped in a deterministic safety net.
Here, an LLM is the *grader* — so the central question is not "is the model's label safe to act on?"
but **"is our measurement of quality itself trustworthy, reproducible, and honest about its limits?"**

Two failure modes dominate and must be designed against:

1. **Over-delegation to the judge** — asking an LLM to score things a deterministic check could verify
   exactly (schema, ranges, formats, presence, masking). This adds cost, latency, and nondeterminism
   for zero benefit.
2. **Treating the judge as ground truth** — reporting LLM-judge scores as if they were correct, with
   no calibration against humans and no signal when the judge drifts.

## Decision drivers

- **Reproducible, offline eval** — the Layer-2 suite must run in CI-equivalent local conditions with
  no model, no network, no keys.
- **Deterministic-where-possible** — never spend an LLM call on a checkable fact.
- **Judge honesty** — the grader's trust must be *measured* (vs. humans) and *surfaced*, never assumed.
- **Cost–quality–latency visibility** — a harness that hides its own cost is not an AI-PM artifact.
- **Secret hygiene & local-first** — cloud models optional, behind env, never load-bearing for tests.

## Considered options

1. **Pure deterministic scoring** — only assertions, no judge. Reproducible but **cannot score
   subjective quality** (groundedness, helpfulness) — the whole reason to grade generative output.
2. **Pure LLM-as-judge** — judge scores everything. Flexible but **nondeterministic, uncalibrated,
   wasteful on checkable facts, and dishonest** (judge treated as truth).
3. **Hybrid: deterministic-first + LLM-as-judge for residual subjective dims, with a calibrated,
   stub-default judge.** **← chosen**

## Decision

**Option 3.** Deterministic assertions (the harness's proven 5-type taxonomy) run **first** and own
every checkable property. The **LLM-as-judge** scores only the residual subjective dimensions
(groundedness, relevance, helpfulness, safety) as schema-validated 1–5 scores. For CI and the Layer-2
suite, both the subject-under-test and the judge run as **deterministic stubs**, so the suite is
offline and reproducible. The live judge (local Ollama by default; cloud optional) is calibrated
against a small **human-labeled** slice; the run reports **judge–human agreement** and flags
`judgeTrust: "low"` below threshold instead of silently trusting the judge.

### Why not Option 1 (pure deterministic)
Cannot measure subjective generation quality — the reason a *generative* eval harness exists at all.

### Why not Option 2 (pure LLM-as-judge)
- **Non-reproducible / flaky** — judge output varies across runs and model versions.
- **Wasteful + weaker** — delegates exactly-checkable facts to a fuzzy grader.
- **Dishonest** — no calibration, no drift signal; the judge is silently treated as ground truth.

### Why Option 3
It is the only option that scores subjective quality **without** giving up reproducibility, determinism
where it belongs, or honesty about the grader. The stub default guarantees an offline Layer-2 suite;
the deterministic-first rule guarantees no wasted/fuzzy checks; the calibration + `judgeTrust` flag
guarantees the judge is measured, not assumed.

## Consequences

**Positive**
- Scores subjective quality while keeping a reproducible, offline Layer-2 eval.
- No secrets in the hot path; no paid cloud dependency; judge optional at runtime.
- The hardest, most senior failure mode — *who judges the judge* — is an explicit, surfaced metric.

**Negative / accepted trade-offs**
- The reproducible suite validates the **stub scorer + plumbing**, not the live judge's accuracy — so
  judge evaluation is a separate, manual, honestly-labeled activity (see eval-plan).
- A configuration surface (stub vs. live judge; model fan-out list) must be defended in tests so a
  misconfiguration cannot route the Layer-2 suite through a live model.
- Calibration requires a small hand-labeled slice to be maintained as the human reference.

## Honest framing for the résumé / interview

Narrate this as *"a hybrid eval harness — deterministic assertions for checkable facts, an LLM-as-judge
for subjective dimensions, with the judge calibrated against human labels and a judge-drift guard, all
reproducible offline via a stub default."* The differentiation is the **judge calibration + drift
guard** (who-judges-the-judge) and the **cost–quality–latency surfacing**, not "I used GPT to grade
outputs."
