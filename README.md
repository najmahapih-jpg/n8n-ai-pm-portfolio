# n8n Product Feedback Intelligence Workflow

Workflow-as-Code portfolio project: a local n8n API that turns free-text product feedback into
**structured product signal**. It classifies theme + sentiment + urgency with an
**LLM-in-the-loop classifier that has a deterministic rule fallback**, clusters to a fixed
taxonomy, scores urgency × volume, gates churn-risk and critical items through a
**human-in-the-loop approval branch**, and emits a **redacted audit event**.

This is the third workflow on the shared "Workflow-as-Code" harness and the **first to put a
real model in the decision loop**. It is the build that the deterministic-vs-LLM ADRs in the
sibling repos (`n8n-workflow-as-code` / support-triage, `n8n-lead-intelligence-workflow`)
explicitly pointed to.

> **Status: v0.1.0 — built and behaviorally verified.** The 25-node graph is live in n8n,
> exported to a scrubbed canonical + release snapshot, and all **10 pin-data eval cases pass**
> (themes, sentiment, urgency, scoring, the human-in-the-loop gate, the confidence→fallback path,
> prompt-injection resistance, PII redaction, and validation). The offline static gate (parse +
> secret scan + node-floor + registry freshness) is green. Built **eval-first**: the requirement
> spec, eval plan, and ADR were authored before any node.

## Why this project (AI-PM framing)

Turning unstructured user feedback into actionable roadmap signal is the canonical AI-PM job.
Unlike the two sibling workflows (both deterministic rule engines), this one demonstrates the
competencies AI-PM roles actually test for:

- A **real LLM in the decision loop**, wrapped in a documented eval — the #1 hiring-manager differentiator.
- **Failure-mode thinking**: a confidence threshold + deterministic fallback so low-confidence or
  schema-invalid model output degrades gracefully instead of producing garbage.
- **Human-in-the-loop governance**: churn-risk / critical items are gated for human approval, not auto-actioned.
- **Responsible-AI**: a redacted audit trail and PII minimization as tested invariants.

## Honest eval framing (read this first)

The reproducible eval validates the **deterministic stub classifier and the fallback path** —
i.e. schema-conformance, value ranges, branch shape, and graceful degradation. The **live LLM
(local Ollama) is demonstrated manually**, not graded by the suite. We do **not** claim the eval
"grades the model." See [docs/eval-plan.md](docs/eval-plan.md) for exactly what is and isn't proven.

## Two-tier validation (same as the harness)

- **Tier 1 — Static gate (CI, offline):** PS parse, fixture JSON parse, workflow JSON structure, secret scan.
- **Tier 2 — Behavioral eval (local, live n8n):** `Test-ProductFeedbackWorkflow.ps1` via the official n8n MCP — runs the stub classifier so the suite is offline-reproducible.

## Classifier modes

- **`stub` (default for CI + eval):** deterministic keyword classifier; reproducible, no network, no model weights.
- **`ollama` (live demo):** env-switchable local LLM path (`host.docker.internal:11434`). Off the critical path so Windows/Docker host-networking friction never blocks the eval.

## Node graph (25 nodes, live)

```
webhook
  -> normalize payload
  -> validate (feedbackText required)
  -> classify (stub | ollama)  -> { theme, sentiment, confidence }
  -> confidence gate + deterministic fallback (low conf / invalid -> keyword rules)
  -> map to fixed taxonomy + derive urgency
  -> score priority (urgency x reportedCount)
  -> human-in-the-loop branch (churn_risk OR critical -> awaiting_approval)
  -> redacted audit event
  -> optional Feishu alert
  -> structured response
```

## Docs & artifacts

- [fixtures/requests/product-feedback-intelligence.md](fixtures/requests/product-feedback-intelligence.md) — requirement spec (Problem → Solution → Impact + Control).
- [docs/eval-plan.md](docs/eval-plan.md) — theme taxonomy, golden fixture table, assertion map, regression semantics.
- [docs/adr/0001-llm-classification-with-deterministic-fallback.md](docs/adr/0001-llm-classification-with-deterministic-fallback.md) — the LLM-with-fallback decision.
- SDK source: `workflows/sdk/product-feedback-intelligence.workflow.js` (+ `.meta.json`); scrubbed canonical + release snapshots in `workflows/canonical` / `workflows/releases`; generated registry in `docs/registry/`.

## Verify

```powershell
npm run verify:static   # offline gate: parse + secret scan + node floor + registry freshness
npm run verify:live     # connection check -> SDK sync -> 10-case behavioral eval (needs local n8n)
```

Behavioral eval (`scripts/Test-ProductFeedbackWorkflow.ps1`): **10/10 cases pass** against local n8n workflow `6Gc3wmri0tJre07B` — every theme, the churn-risk human-review gate, the low-confidence→fallback path, and prompt-injection resistance (input asking for `theme=praise` resolves to `other`).
