# Case Study — Lead Scoring as an MCP Tool

This workflow exposes the deterministic **Lead Intelligence API** as an **agent-callable MCP
tool**, so an MCP client (e.g. Claude via the official n8n MCP) can invoke lead scoring as a
tool call rather than a webhook. It is a thin exposure layer over an already-eval-backed core.

- **SDK source:** [`workflows/sdk/lead-scoring-mcp-tool.workflow.js`](../workflows/sdk/lead-scoring-mcp-tool.workflow.js)
- **Live workflow id:** `wLyTjQRtlpUKgX5d` (MCP server) → delegates to `xhZ0XMNvi4LeVWzk` (Lead Intelligence API)
- **Status:** validated server-side (`validate_workflow`) and created live; 3 nodes.

## Architecture

```
MCP client (Claude, Cursor, ...)
        │  tool call: score_lead({ lead })
        ▼
MCP Server Trigger  (n8n-nodes-langchain.mcpTrigger, path "lead-scoring", SSE)
        │  ai_tool (subnodes.tools)
        ▼
Call n8n Workflow Tool  (toolWorkflow → workflowId xhZ0XMNvi4LeVWzk)
        │  main
        ▼
Portfolio - Lead Intelligence API  (deterministic scoring, 38 nodes)
        │  structured response
        ▼
{ grade, priorityScore, icpFitScore, intentScore, route, followUp, auditEventId, policyVersion }
        ▲  returned to the MCP client as the tool result
```

Two layers, deliberately decoupled:
- **Exposure layer (this workflow):** turns the scoring workflow into an MCP tool. Thin (3 nodes).
- **Logic layer (Lead Intelligence API):** the deterministic scoring, with its 11-fixture pin-data
  behavioral eval (`scripts/Test-LeadIntelligenceWorkflow.ps1`) as the regression backstop. This
  MCP layer adds no new business logic, so that eval still covers correctness of the scoring.

## Round-trip test — verified

Exercised end-to-end (2026-05-29) with a raw MCP client (PowerShell JSON-RPC over the
Streamable-HTTP endpoint). Both the MCP-server workflow (`wLyTjQRtlpUKgX5d`) and the lead
sub-workflow (`xhZ0XMNvi4LeVWzk`) must be **active/published** first.

| Step | Endpoint / method | Result |
| --- | --- | --- |
| publish | `publish_workflow` (both workflows) | active |
| `initialize` | `POST /mcp/lead-scoring` | 200, session id, `serverInfo: Lead_Scoring_MCP_Server` |
| `tools/list` | same session | `score_lead` exposed with **12 typed inputs** (email, companyName, …) via `$fromAI` |
| `tools/call score_lead` | same session | returns the **graded result** — hot-enterprise → `grade A`, `priorityScore 97`, `route enterprise-ae`, SLA 2h, `redactedEmail b***@finops.example` |

**Verified end-to-end — returns real scoring.** A live `tools/call score_lead` with a lead
payload traverses the full chain (MCP client → MCP Server Trigger → `score_lead` → **Execute
Workflow Trigger** → deterministic scoring → structured response → back to client) and returns
the graded result. The hot-enterprise payload returns `grade A`, `priorityScore 97`, `icpFitScore
95`, `intentScore 100`, `route enterprise-ae`, SLA 2h, and `redactedEmail b***@finops.example` —
**identical to the `lead-hot-enterprise` fixture's golden values**, so the behavioral eval is the
oracle for the live tool's output.

How it was wired (the fix the first test run pointed to):

1. The lead workflow gained an `n8n-nodes-base.executeWorkflowTrigger` with declared typed inputs
   (email, companyName, …) wired to `Normalize Lead Payload`, so sub-workflow calls route there
   instead of the manual demo trigger. The 11-fixture eval still passes — the manual/webhook
   paths are unchanged (the workflow is now 39 nodes, v0.1.2).
2. `score_lead`'s `workflowInputs` map each field via `$fromAI(...)`, so `tools/list` exposes the
   12 typed inputs and the agent fills them.
3. **Both** the MCP-server workflow and the sub-workflow must be **active/published** — an
   inactive sub-workflow fails with *"Workflow is not active and cannot be executed."*

## Honest scoping (read this)

- **The MCP round-trip is verified end-to-end and returns a real graded result** (see the table
  above): the SDK validates, both workflows publish, and a live `tools/call` returns the same
  grade/score as the fixtures. The scoring logic stays covered by the lead workflow's 11-fixture
  behavioral eval; the MCP layer adds no logic to grade — it maps inputs and delegates.
- **The SSE endpoint is unauthenticated (`authentication: none`)** for local use. This is fine
  on a local-only box; **add bearer/header auth before any network exposure** — an open MCP
  trigger is a real exposure boundary, not a detail to gloss over.
- **Not run through the single-workflow canonical/release/38-node gate.** This is a deliberate
  3-node thin layer; the harness's node-floor + canonical export target the large scoring
  workflow. Wiring a second workflow into the single-workflow harness tooling is a follow-up,
  not a correctness gap.

## Why this matters for an AI PM

- Demonstrates the **agent tool-use paradigm** (2025-2026): turning an automation into a tool an
  LLM agent can call and govern — rare in PM portfolios.
- Shows the **design-time vs runtime MCP architecture** judgment: a read-only design-time MCP for
  building workflows, vs a runtime MCP Server Trigger that *publishes* a workflow as a tool.
- Reuses an **eval-backed** core instead of re-implementing logic — the right instinct for
  shipping safely.

**Résumé line:** *Published a deterministic lead-scoring workflow as an agent-callable MCP tool
(n8n MCP Server Trigger → Call-Workflow tool), reusing its 11-fixture behavioral eval as the
correctness backstop and documenting the unauthenticated-SSE exposure boundary.*
