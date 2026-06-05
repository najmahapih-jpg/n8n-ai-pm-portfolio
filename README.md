# n8n-autonomous-agent

**Capstone C** of the n8n Workflow-as-Code portfolio — an **autonomous agent** that turns an inbound signal
(a ticket / feedback / question) into a consolidated outcome by **orchestrating the other portfolio workflows
as tools**, under guardrails, graded by **agent-trajectory evals**.

> **Status: capstone complete — live LLM planner + live gateway tools built & run (2026-06-05).** Green: the agent
> core (`verify:agent` **59/59**), the SDK workflow + differential (`verify:workflow` **24/24**), the gateway tool
> executor (`verify:gateway-client` **16/16**), and `verify:static`. **Deployed** to n8n (id `fIAHA00y4Rft2BrC`,
> active). Two live tiers under the **same** trajectory rubric: **`verify:llm`** — a real LLM plans (Ollama
> `llama3.2:3b`): free-form **2/6 (low)** vs LLM-classifier + deterministic routing **6/6 (high)**; and
> **`verify:tools`** — the agent SIGNS each call and drives **real portfolio siblings** in-process via the deployed
> interaction-gateway (a bug ran the live 2-step `rag → support-triage` route; `product-feedback` returned a real
> classification; refusals held with zero gateway calls). The agent's tools ARE the portfolio, over the signed gateway.

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

1. ✅ The SDK workflow (the n8n agent loop wrapping the core) + `verify:static` / `verify:json` — **deployed +
   live-verified** (id `fIAHA00y4Rft2BrC`).
2. ✅ Live LLM planner (`verify:llm`, Ollama `llama3.2:3b`) graded by the **same** rubric — free-form 2/6 (low) vs
   LLM-classifier + deterministic routing 6/6 (high); an honest architecture finding, no rubric loosening.
3. ✅ Live tool execution (`verify:tools`) via the deployed interaction-gateway (sign → route → real in-process
   sibling → observe) — 3 real siblings driven, same rubric. Follow-up: align the agent's per-tool payloads to each
   sibling's input contract (support-triage returned a 400 on the agent's `{subject, message}` shape).

License: Apache-2.0.
