# ADR-0001: Deterministic rule-based routing over LLM classification

- **Status:** Accepted
- **Date:** 2026-05-29 (recorded; the decision has been embodied since v0.1.0)
- **Workflow:** `Portfolio - Support Triage API` (`workflows/sdk/portfolio-support-triage-api.workflow.js`)
- **Related:** [eval-methodology.md](../eval-methodology.md)

## Context

The Support Triage API receives a support ticket via webhook and must classify category
(incident / billing / account / bug / general), score urgency (critical / urgent / high /
normal), route an owning team, compute an SLA, decide escalation, emit a redacted audit event,
and optionally send a Feishu alert. It runs **local-only** in Docker with no public deployment,
strict secret hygiene, and `NODES_EXCLUDE` blocking dangerous nodes. For portfolio review the
decisions must be **reproducible and auditable**.

## Decision drivers

- **Reproducibility / auditability** — same input must yield the same, defensible decision.
- **Evaluability** — a regression suite that is not flaky (see eval-methodology.md).
- **Cost & latency** — local, ~0 per-call cost, sub-second response.
- **Secret hygiene & offline CI** — no API keys in the hot path; CI must run with no network and no n8n.
- **Failure modes** — no hallucinated categories/teams; malformed input must degrade, not crash.

## Considered options

1. **Deterministic rule engine** (alias normalization → keyword/structured classification → scored urgency → routing table). **← chosen**
2. **LLM classifier** (hosted or local model) for category + urgency.
3. **Hybrid** — LLM proposes, rules validate/override. **← deferred**

## Decision

**Option 1.** Classification and routing are pure, versioned rules (`policyVersion =
supportops-triage-v0.3.0-local-feishu`).

### Why not Option 2 (LLM)

| Driver | LLM outcome |
| --- | --- |
| Reproducibility | Same ticket can yield different labels across runs/model versions → exact-match eval impossible, regression suite flaky. |
| Cost / latency | Per-call token cost + network latency vs. ~0 cost / sub-second for rules. |
| Secret / offline | Hosted model needs an API key in the hot path (breaks secret hygiene) and breaks offline CI; a local model (Ollama) adds multi-GB weights + host-networking dependencies. |
| Failure mode | Can hallucinate a non-existent team/category; routing to a phantom queue is worse than a conservative default. |
| Eval cost | Grading free-text output needs schema + range + confidence assertions — heavier than the problem warrants for a **fixed 5-category** taxonomy. |

### Why not Option 3 (hybrid) yet

A hybrid inherits the LLM's cost/latency/eval burden without a problem that needs it — the
category set is small and well-separated, so semantic nuance buys little. Deferred until the
label space is genuinely open-ended.

## Consequences

**Positive**
- Deterministic → **exact-match behavioral eval** is possible (the 8-fixture suite).
- ~0 per-call cost, sub-second latency, **offline-CI-safe**, **no secrets in the hot path**.
- No hallucinated routes; malformed input **degrades gracefully** to `general/normal` (proven by the `invalid-date` fixture).

**Negative / accepted trade-offs**
- No semantic understanding — a novel phrasing outside the keyword rules falls to `general`.
- The taxonomy is fixed; adding a category is a code + fixture change, not a prompt tweak.

**Mitigation** — a catch-all `general` path plus a validation gate, and a coverage matrix that
forces one fixture per category so any rule drift fails loudly.

## When an LLM *would* be the right call (forward pointer)

When the input is **open-ended free text whose useful labels are not a small fixed set** — for
example, clustering product feedback into *emergent* themes — recall of novel themes matters
more than reproducibility, and no deterministic rule set can enumerate the label space.

That is precisely the next project — **now built (2026-05-29)**; see the
`n8n-product-feedback-intelligence` repo (10-case pin-data eval green against local n8n). The
**Product Feedback Intelligence API** revisited this ADR and chose an **LLM classifier with a deterministic rule fallback and a
confidence threshold**, evaluated with schema / value-range / graceful-degradation assertions
rather than exact-match. The deterministic fallback is what preserves the reproducible, offline
eval guaranteed here — the LLM is added where it earns its cost, not everywhere.
