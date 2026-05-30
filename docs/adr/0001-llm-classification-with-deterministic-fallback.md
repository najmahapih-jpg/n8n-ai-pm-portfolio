# ADR-0001: LLM classification with a deterministic fallback

- **Status:** Accepted
- **Date:** 2026-05-29
- **Workflow:** `Portfolio - Product Feedback Intelligence API` (`workflows/sdk/product-feedback-intelligence.workflow.js`, v0.2.0)
- **Related:** [eval-plan.md](../eval-plan.md); the sibling decisions this revisits —
  `n8n-workflow-as-code/docs/adr/0001-deterministic-routing-over-llm-classification.md` and
  `n8n-lead-intelligence-workflow/docs/adr/0001-deterministic-scoring-over-llm.md`.

> **Update (2026-05-30, v0.2.0): implemented + verified live.** The LLM-with-fallback decision below
> is now built and demonstrated end-to-end — a per-request `classifierMode: "ollama"` routes to a
> local `llama3.2:3b` via an HTTP node; a real classification flows through the deterministic
> urgency/scoring/human-in-the-loop/audit steps, and the confidence gate falls back to the keyword
> classifier on low-confidence or invalid output. The deterministic stub stays the default, so the
> 10-fixture behavioral eval remains offline and reproducible (10/10).

## Context

The sibling ADRs chose **deterministic** logic and recorded the condition under which an LLM would
be the right call: *open-ended free text whose useful labels are not a small fixed set, where
recall of novel phrasing matters more than reproducibility.* Product feedback is exactly that
case — the same intent is phrased a thousand ways, and keyword rules miss novel wording. So this
workflow revisits the decision and **chooses an LLM**, but only behind the safety net that keeps
the harness's reproducibility, offline CI, and secret hygiene intact.

## Decision drivers

- **Recall over novel phrasing** — the reason to introduce a model at all.
- **Reproducible, offline eval** — the suite must run in CI-equivalent local conditions without a model or network.
- **Graceful degradation** — low-confidence or malformed model output must never produce garbage.
- **Secret hygiene & local-only** — no API keys in the hot path; no paid cloud.
- **Governance** — the model must not unilaterally action high-severity items.

## Considered options

1. **Pure deterministic keyword classifier** — what the siblings do.
2. **Pure LLM classifier** — model output used directly.
3. **LLM classifier + deterministic fallback + confidence gate**, with an env-switchable stub. **← chosen**

## Decision

**Option 3.** A local LLM (Ollama) classifies theme + sentiment + confidence; if confidence is
below threshold or the output fails schema validation, a deterministic keyword classifier takes
over (`classifierSource = "fallback"`). **Urgency is always derived deterministically**, never set
by the model. For CI and the eval, the classifier runs as a **deterministic stub** so the suite is
offline and reproducible.

### Why not Option 1 (pure deterministic)

Misses novel phrasing — the recall ceiling is the whole reason this workflow exists.

### Why not Option 2 (pure LLM)

- **Non-reproducible / flaky eval** — output varies across runs and model versions.
- **No floor** — a bad or hallucinated label would route real decisions wrongly.
- **Secret / offline** — a hosted model breaks offline CI and secret hygiene; even a local model
  shouldn't be a hard dependency of the test suite.

### Why Option 3

It is the only option that adds the model's recall **without** giving up the deterministic core the
harness depends on: the fallback guarantees a valid output, the derived urgency guarantees safe
routing, and the stub guarantees a reproducible eval. The live model is a demonstrated enhancement,
not a load-bearing dependency of correctness.

## Consequences

**Positive**
- Gains LLM recall on free text while keeping a reproducible, offline behavioral eval.
- No secrets in the hot path; no paid cloud; the model is optional at runtime.
- Failure modes are explicit and tested: confidence-fallback and a human-in-the-loop gate.

**Negative / accepted trade-offs**
- The reproducible eval validates the **stub + fallback**, not the live model's quality — so model
  evaluation is a separate, manual, honestly-labelled activity (see eval-plan.md).
- Two classifier paths add a configuration surface (`mode` switch) that must be defended in tests
  so a misconfiguration cannot silently send the eval through the live model.
- Ollama adds a local model-weights + host-networking prerequisite for the live demo only.

## Honest framing for the résumé / interview

Narrate this as *"an LLM-in-the-loop classifier with a deterministic fallback and a reproducible
eval for schema-conformance and graceful degradation,"* not *"evals that grade my model."* The
differentiation is real at the capability level (first model in the loop, first HITL gate); the
rigor is in the fallback design and the honest eval scope.
