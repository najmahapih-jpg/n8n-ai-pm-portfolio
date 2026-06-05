# n8n-autonomous-agent

**Capstone C** of the n8n Workflow-as-Code portfolio — an **autonomous agent** that turns an inbound signal
(a ticket / feedback / question) into a consolidated outcome by **orchestrating the other portfolio workflows
as tools**, under guardrails, graded by **agent-trajectory evals**.

> **Status: design + pure core (2026-06-05).** The agent core (`scripts/lib/agent-core.mjs`) and its offline
> trajectory eval (`verify:agent`, **39/39**) are built and proven. The SDK workflow (the n8n agent loop) + the
> live LLM planner + live gateway tools are the next increments — per the portfolio's eval-first rule
> (spec → eval-plan → ADR → core → workflow).

## What it is

Given a task, the agent runs a **tool-use loop**: plan → pick a tool (an allowlisted **intent**) → call it →
observe → decide (done? next tool? refuse?) → … → synthesize. Its tools ARE the portfolio workflows, reached in
production via the **signed interaction-gateway** (intent-routed, in-process, no secret over HTTP):
`support-triage`, `product-feedback`, `rag`, `eval`, `drift`. A bug/outage, for example, becomes a **2-step**
trajectory: check the KB (`rag`) for a known issue, then route the ticket (`support-triage`).

## The eval thesis (why this is the capstone)

The hardest part of an agent project is putting a **non-deterministic** LLM under a CI gate. The core makes the
**planner** and **tool-executor** *injected*, so:

- **Offline / CI**: a **deterministic keyword planner** over **stub tools** → a byte-stable trajectory →
  `scoreTrajectory` (a pure boolean rubric) grades it. Reproducible, no LLM, no network.
- **Live**: a real **LLM planner** + the **gateway** tools — graded by the **same** rubric. The LLM must call
  the right tools, in the right order, under the same guardrails.

This is exactly what **A (eval harness)** and **D (drift monitor)** were built first to de-risk.

## Guardrails (hard-acceptance negatives — see `docs/eval-plan.md`)

`refusal` (destructive / prompt-injection / out-of-scope → no tool call) · `non-allowlisted-tool` (a hallucinated
tool is never executed) · `max-steps` (bounded loop) · `no-fabricated-result` (a tool failure is recorded
`ok:false`, never invented).

## Design docs

- Spec: [`fixtures/requests/autonomous-agent.md`](fixtures/requests/autonomous-agent.md)
- Eval plan: [`docs/eval-plan.md`](docs/eval-plan.md)
- Architecture decision: [`docs/adr/0001-autonomous-agent-architecture.md`](docs/adr/0001-autonomous-agent-architecture.md)

## Next increments

1. The SDK workflow (the n8n agent loop wrapping the core) + `verify:static` / `verify:json` gates.
2. Live LLM planner (Ollama default) graded by the same trajectory rubric (judge-style calibration vs the stub).
3. Live tool execution via the deployed interaction-gateway (sign → route → observe).

License: Apache-2.0.
