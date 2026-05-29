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

## Round-trip test (how to verify)

The MCP Server Trigger serves an SSE endpoint at `/<mcp-base>/lead-scoring`. To exercise the
round trip:

1. Point an MCP client at the endpoint (the official n8n MCP / an `mcpClient` node / Claude).
2. List tools → expect `score_lead` with the documented input description.
3. Call `score_lead` with a lead object (e.g. the `lead-hot-enterprise` fixture payload).
4. Expect a structured result with `grade`, `priorityScore`, `route.ownerQueue`, `followUp.slaHours`,
   `auditEventId`, and `policyVersion = lead-intel-v0.1.0`.

Because the tool delegates to `xhZ0XMNvi4LeVWzk`, the expected scoring for any fixture matches the
behavioral eval's golden table for that fixture — the eval *is* the oracle for the tool's output.

## Honest scoping (read this)

- **The agent round-trip is a manual/live MCP-client demo**, not part of the offline pin-data
  suite. What is machine-verified here: the SDK **validates** (`validate_workflow`) and the
  workflow was **created** live. What the existing eval verifies: the **scoring logic** the tool
  delegates to. The MCP layer adds no logic to grade.
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
