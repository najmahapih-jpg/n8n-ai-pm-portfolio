# Requirement Spec — LLM Eval Harness API

*Captured before any node is built (eval-first). Companion: [docs/eval-plan.md](../../docs/eval-plan.md), [docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md](../../docs/adr/0001-hybrid-deterministic-and-llm-judge-scoring.md).*

## Problem

AI-PM work lives or dies on **measuring AI quality**, yet "eval harness" is the single
highest-signal portfolio artifact precisely because almost nobody has built one. The three sibling
workflows in this portfolio (`support-triage`, `lead-intelligence`, `product-feedback`) each embed a
behavioral eval that tests **their own plumbing**. None of them answers the harder, more general
question an AI-PM is actually hired to own:

> Given a task and a candidate AI system (a model, a prompt, or a workflow), **how good is the
> output — and how do I know my measurement of "good" is itself trustworthy?**

## Solution

A local n8n workflow — `Portfolio - LLM Eval Harness API` — that **grades AI systems**, not end-user
tasks. Given an eval-run request (webhook) or on a schedule (batch), it:

1. **Loads a golden dataset** of tasks (input + optional reference answer + per-task assertions).
2. **Fans out** each task to one or more **subjects-under-test (SUT)**:
   - `mode: "model"` — call a model directly (local Ollama default; cloud OpenAI/Claude/Gemini optional).
   - `mode: "workflow"` — call an existing portfolio workflow (e.g. `product-feedback`) — the
     **connected-projects** path that lets this harness grade its own siblings.
3. **Scores** each output with a **hybrid scorer**:
   - **Deterministic assertions** (the harness's proven 5-type taxonomy) for anything checkable:
     schema-conformance, numeric range/band, format/parse, structural-absence, masking/relational.
   - **LLM-as-judge** for subjective rubric dimensions only — *groundedness/faithfulness, relevance,
     helpfulness, safety* — returning a 1–5 score + rationale, schema-validated before use.
4. **Aggregates** per-SUT / per-rubric metrics, **cost & latency** per model, and a **regression
   delta** vs. the previous run.
5. **Guards the judge**: compares the LLM-judge's scores against a small **human-labeled** calibration
   slice and reports **judge–human agreement**; if agreement drops below threshold, the run is flagged
   (`judgeTrust: "low"`) rather than silently trusted.
6. Emits a **redacted audit event** + a **structured report** (JSON; optional Markdown/Feishu).

### Default behavior (reproducible)
The default SUT and default judge run as **deterministic stubs**, so the suite is offline,
CI-reproducible, and free — exactly mirroring `product-feedback`'s stub-default discipline. Live
multi-model fan-out and the live judge are **optional, documented, non-CI** demonstrations.

## Impact

- Demonstrates the **#1-ranked 2026 AI-PM portfolio artifact** (an eval harness) at capability level.
- Proves **system-behavior ownership**: golden datasets, LLM-as-judge, judge bias/calibration,
  pass-rate / regression, and the **cost–quality–latency triangle**.
- Ties the portfolio together: it **evaluates `product-feedback` (and the future RAG project)** as
  subjects-under-test → the "connected projects" hiring signal.

## Control (failure-mode & governance requirements)

| Requirement | Control |
|---|---|
| Eval must be reproducible / offline | Stub SUT + stub judge are the **default**; live models are opt-in per request and never in CI. |
| Judge must not be treated as ground truth | Calibrate against human labels; report agreement; flag `judgeTrust: low` below threshold. |
| Deterministic-checkable facts must not be left to the LLM | Deterministic assertions run **first**; the judge only scores residual subjective dims. |
| No secrets in hot path | Cloud model keys live in env, optional; stub/local paths need no keys. |
| No PII / raw-prompt leakage in audit | Redacted audit event; masking asserted as an invariant. |
| Silent quality drift | Regression delta vs. previous run + judge-drift guard surface degradation loudly. |

## Out of scope (v0.1.0)
- Grading the *live* models' absolute quality as a CI claim (that is a separate, manual, honestly
  labeled activity — see eval-plan).
- Public deployment, paid cloud as a hard dependency, real customer data.
