# Eval Plan — LLM Eval Harness API

Written **before** the workflow is built. This is the contract the node graph and the
`Test-EvalHarnessWorkflow.ps1` driver must satisfy. Companion:
[ADR-0001](adr/0001-hybrid-deterministic-and-llm-judge-scoring.md),
[requirement spec](../fixtures/requests/llm-eval-harness.md).

## The recursion, stated plainly (read this first)

This project is an **eval harness**, so it has two layers of "eval" that must not be conflated:

- **Layer 1 — the harness grades a subject-under-test (SUT).** This is the product's job.
- **Layer 2 — *this repo's* behavioral suite grades the harness itself.** This is what
  `verify:static` / `verify:live` run.

**What Layer 2 proves:** the harness's *plumbing* is correct and safe — it loads the golden set,
fans out to the SUT, runs deterministic assertions, invokes the judge, aggregates per-SUT/per-rubric
metrics, computes the regression delta, applies the judge-drift guard, and redacts the audit event.
All of this runs against a **deterministic stub SUT and stub judge**, so it is offline and reproducible.

**What Layer 2 does NOT prove:** that the *live* LLM-judge scores like a human, or that any *live*
model is "good." A stub judge is, by construction, perfectly agreeing — so Layer 2 measures
**mechanics and graceful degradation, not judge accuracy.** Judge accuracy is a **Layer-1, manual,
honestly-labeled** activity: calibrate the live judge against the human-labeled slice and report the
agreement number. We do **not** narrate Layer 2 as "evals that prove my judge is right."

> This honesty is inherited from the sibling ADRs, which warned against narrating a stub-backed suite
> as "evals that grade my model." Here the stake is higher because the model *is* the grader.

## Scorer contract

```
score(taskOutput, task, mode) -> {
  deterministic: { passed: bool, checks: [{ type, field, ok, detail }] },
  judge: { groundedness:1..5, relevance:1..5, helpfulness:1..5, safety:1..5, rationale, judgeSource },
  passed: bool,                 // deterministic AND judge>=threshold
  judgeTrust: "high" | "low"    // from judge-human agreement on the calibration slice
}
```

- `judgeSource = "stub" | "ollama" | "openai" | ...`. Default `stub` (deterministic, reproducible).
- **Deterministic-first rule:** any property that a deterministic check can verify (schema, range,
  format, presence/absence, masking) is checked deterministically and is **never** delegated to the
  judge. The judge only scores residual subjective dimensions.
- **Judge-validation rule:** judge output must pass schema validation (four integer 1–5 scores +
  rationale); on invalid output, discard and mark `judgeSource = "fallback"`, score the subjective
  dims as `null`, and `passed = false` (a broken judge must not silently pass a case).

## Golden dataset (Layer 1 subject cases, planned)

The golden set is the harness's input, not its test. v0.1.0 ships a small, hand-labeled set whose
**purpose is calibration + demonstration**, organized so each case exercises a scorer path:

| Golden case | SUT mode | exercises | expected |
|---|---|---|---|
| `grounded-summary-ok` | model | groundedness pass | judge groundedness ≥ 4, deterministic schema ok |
| `hallucinated-fact` | model | groundedness fail | judge groundedness ≤ 2, `passed=false` |
| `feedback-bug-negative` | workflow (`product-feedback`) | cross-project grading | theme=bug, deterministic exact-match ok |
| `refusal-on-empty-retrieval` | model | safety/abstention | judge safety high, no fabricated facts |
| `prompt-injection-resist` | model | safety | injection ignored; `passed` per policy |
| `over-length-violation` | model | deterministic format | length assertion fails → `passed=false` |

## Layer-2 behavioral suite (what `verify:live` asserts)

Against the **stub** SUT + **stub** judge, every harness run must:

| Field(s) | Assertion type | Helper |
|---|---|---|
| `ok`, `passed`, `judgeSource`, `judgeTrust`, `policyVersion` | **exact-match** | `Assert-Equal` |
| `judge.*` scores (1..5), aggregate pass-rate band, `regressionDelta` band | **numeric-range band** | `Assert-NumberBetween` |
| `processedAt`, per-model `latencyMs` | **format / parse** | `Assert-ParseableDate` / numeric |
| audit & report carry no raw prompt / no PII | **negative + masking** | `Assert-NoRawPiiLeak` |
| broken-judge case withholds a pass; missing-golden returns 400 | **branch-shape / absence** | `Assert-HasNoProperty` |

These are the **same five assertion types** proven in the sibling repos — this workflow **reuses**
the taxonomy, it does not invent a new idiom. The new surface it adds is the **judge-drift guard**
(`judgeTrust`) and the **regression delta**, both asserted as bands.

## Regression semantics

A failure is a behavioral delta. Categoricals (`passed`, `judgeSource`, `judgeTrust`) are exact-matched.
The aggregate pass-rate and `regressionDelta` are asserted as **bands** so a benign weight tweak passes
but a band-crossing change fails loudly. The two highest-severity guards: a **broken judge silently
passing a case**, and a **judge-drift** (agreement below threshold) not being surfaced.

## Production metrics this harness would back (Layer 1)

- **Per-model pass rate** and **per-rubric mean** across the golden set.
- **Judge–human agreement** (the trust metric for the grader itself) — target ≥ 0.8 before a run's
  judge scores are reported without a `judgeTrust: low` flag.
- **Cost & latency per model** — the cost–quality–latency triangle, surfaced per run.
- **Regression delta** vs. the previous run (quality drift over time / prompt drift).
- **Hallucination escape rate** on reference-answer cases — target 0 silent escapes.
