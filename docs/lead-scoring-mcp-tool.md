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
| `tools/list` | same session | `score_lead` exposed (input schema `{ input: string }`, `additionalProperties: true`) |
| `tools/call score_lead` | same session | full chain executes; sub-workflow returns a structured JSON response back through MCP |

**Verified:** the MCP transport, tool discovery, and the delegation chain (MCP client → MCP
Server Trigger → `score_lead` → Lead Intelligence API → structured response → back to client)
work end-to-end. A `tools/call` traverses the entire chain and returns the workflow's own JSON.

**Open finding (input mapping) — the value of running the test.** The tool currently exposes a
generic `input` string, and the lead workflow's entries are manual + webhook triggers (no
*Execute Workflow Trigger* declaring typed inputs), so structured lead fields are not yet mapped
into the sub-workflow. A call therefore lands on the **validation branch** and returns a clean
`400 Missing required lead fields` — which in turn confirms the validation path works over MCP.
Two concrete lessons the test surfaced:

1. **Both** the MCP-server workflow and the called sub-workflow must be active, or the tool call
   fails with *"Workflow is not active and cannot be executed."*
2. To return a graded result, add an `n8n-nodes-base.executeWorkflowTrigger` to the lead workflow
   with declared inputs (email, companyName, …) wired to `Normalize Lead Payload`; the
   Call-Workflow Tool then auto-exposes those typed inputs on `score_lead` for the agent to fill.

Once inputs map through, the expected scoring for any payload matches the behavioral eval's
golden table — the eval *is* the oracle for the tool's output.

## Honest scoping (read this)

- **The MCP round-trip is verified at the transport / discovery / delegation level** (see the
  table above): the SDK validates, the workflow is created + published, and a live `tools/call`
  traverses the full chain and returns a structured response. **Returning a graded result
  end-to-end is gated on the input-mapping fix (Execute Workflow Trigger).** The scoring logic
  itself stays covered by the lead workflow's 11-fixture behavioral eval; the MCP layer adds no
  logic to grade.
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
