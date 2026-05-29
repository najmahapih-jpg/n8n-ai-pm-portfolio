# ADR-0001: Deterministic local scoring over LLM / external enrichment

- **Status:** Accepted
- **Date:** 2026-05-29 (recorded; embodied since v0.1.0)
- **Workflow:** `Portfolio - Lead Intelligence API` (`workflows/sdk/lead-intelligence.workflow.js`)
- **Related:** [eval-methodology.md](../eval-methodology.md), [scoring-policy.md](../scoring-policy.md), [source-priority.md](../source-priority.md)

## Context

The Lead Intelligence API accepts a B2B lead intake payload and must deduplicate, enrich, score
ICP fit and intent, assign a grade (A–D), route an owner queue, build a CRM-ready payload, and
emit a redacted audit event. The request brief mandates **local enrichment with deterministic
rules, without external APIs**, and a response that returns only a safe subset. Scores must be
**explainable** to a sales team that will act on them.

## Decision drivers

- **Explainability** — sales must be able to ask "why grade B?" and get a deterministic answer
  (ICP fit + intent + weighted priority), not a black-box number.
- **Reproducibility** — a lead's grade cannot change between runs; downstream routing and SLAs
  depend on it.
- **Idempotency / dedup determinism** — the same lead must collapse to the same record.
- **Cost, latency, secret hygiene, offline CI** — same constraints as the rest of the harness.
- **PII posture** — minimize PII egress; the workflow already redacts audit + response.

## Considered options

1. **Deterministic local rules** (alias normalization → dedup → ICP/intent scoring → grade →
   routing table → CRM payload). **← chosen**
2. **LLM scoring / enrichment** — a model infers firmographics and an intent score from free text.
3. **External enrichment API** (Clearbit-style firmographic lookup).

## Decision

**Option 1.** Scoring is a pure, versioned function (`policyVersion = lead-intel-v0.1.0`):
`priorityScore = round(icpFitScore*0.58 + intentScore*0.42)`, competitor scores capped at 25,
manual override floors priority at 85.

### Why not Option 2 (LLM)

- **Not explainable / not reproducible** — a grade that shifts run-to-run is one sales can't
  trust; the weighted formula gives a transparent, auditable rationale.
- **Hallucinated firmographics** — a model may invent employee counts or industries; wrong
  enrichment silently corrupts the score.
- **Cost / latency / secret / offline** — same disqualifiers as the support-triage ADR (API key
  in the hot path, breaks offline CI; local model adds heavy deps).

### Why not Option 3 (external enrichment API)

- **Paid + network dependency** — violates the local-only, no-paid-cloud constraint.
- **PII egress** — sending a lead's email/domain to a third party conflicts with the workflow's
  redacted-audit PII posture.
- Deferred behind `source-priority.md`: external responses must not change v0.1 scoring until a
  new policy version **and a new fixture matrix** are added.

## Consequences

**Positive**
- Deterministic → **numeric-range-band behavioral eval** (priority bands map to grades), plus
  structural and masking assertions (see eval-methodology.md).
- Explainable scores, ~0 cost, sub-second, offline-CI-safe, no PII egress, no secrets in the hot path.

**Negative / accepted trade-offs**
- Enrichment is limited to payload fields + local rules; no live firmographic lookup.
- The rubric is fixed per policy version; tuning weights is a versioned code + fixture change.

**Mitigation** — `source-priority.md` defines the precedence order so a future adapter can be
added without silently changing v0.1 behavior.

## When an LLM / external source *would* be the right call (forward pointer)

A model earns its place where **semantic intent extraction from free text beats keyword rules**
(e.g., scoring nuanced `message`/`intentSignals` content) — but only as an **intent sub-score
with a deterministic floor**, so the grade stays explainable and the eval stays reproducible.
The sibling **Product Feedback Intelligence API** (**now built (2026-05-29)** — see the
`n8n-product-feedback-intelligence` repo, 10-case pin-data eval green) demonstrates exactly this
LLM-with-fallback discipline; if adopted here later, it would follow the same pattern under a new
policy version and an expanded fixture matrix. The same repo also exposes this lead workflow as an
MCP tool — see `docs/lead-scoring-mcp-tool.md`.
