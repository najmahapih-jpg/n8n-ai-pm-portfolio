# ADR-0002: Deploy via the n8n public REST API when the n8n MCP is unavailable

- **Status:** Accepted
- **Date:** 2026-05-30
- **Workflow:** `Portfolio - LLM Eval Harness API` (v0.1.0, live id `IhmmthDFMKdDbgvp`)
- **Related:** [ADR-0001](0001-hybrid-deterministic-and-llm-judge-scoring.md). The three sibling projects
  use the **official n8n MCP** for the SDK→n8n deploy + validation step.

## Context

The sibling projects author workflows as `@n8n/workflow-sdk` code and rely on the **official n8n MCP**
(`create_workflow_from_code`, `validate_workflow`, `test_workflow`) for two things: (1) compiling SDK
source into a live workflow, and (2) node/workflow **validation** before deploy — the "never trust
defaults" safety net.

This project was built in an environment where **no n8n MCP is connected**, but a local n8n instance
is running (Docker: `n8n`, `n8n-runners`, `n8n-postgres`) and an `N8N_API_KEY` is available. We needed
a deploy path that does not depend on any MCP server.

## Decision

1. **Compile standalone.** `scripts/lib/compile-sdk.mjs` turns the `.workflow.js` SDK source into
   deployable workflow JSON using `@n8n/workflow-sdk` directly — no MCP in the loop.
2. **Deploy via the public REST API.** `POST /api/v1/workflows` (create) → `POST /workflows/{id}/activate`,
   authenticated with the `X-N8N-API-KEY` header. Read-only fields (`id`, `active`) are stripped before create.
3. **Validate by live execution.** Behavior is verified by POSTing fixtures to the production webhook
   (`/webhook/portfolio/llm-eval-harness`) and asserting the structured response.
4. The `.workflow.js` SDK source remains the **single source of truth**; the compiled JSON and the live
   workflow are derived artifacts.

## Consequences

**Positive**
- No hard dependency on any MCP server; the project is portable to any environment with a running n8n + API key.
- Deploy is fully scriptable / CI-able.
- SDK source stays the source of truth, so an MCP can be reintroduced later as an *additional* validation pass without changing the build.

**Negative / mitigations**
- We lose the MCP's **pre-deploy node/workflow validation**. Mitigations: (1) build in
  **walking-skeleton vertical slices** and verify each by **live execution** — the smoke test *is* the
  validation; (2) a static JSON gate (parse + minimum-node floor + secret scan) before deploy; (3) the
  "never trust defaults" discipline is applied manually when authoring the SDK source.

## Evidence

v0.1.0 skeleton deployed live as workflow `IhmmthDFMKdDbgvp` (18 nodes, active) and smoke-verified on
2026-05-30: a valid pass+fail run returned **HTTP 200** with `passRate: 0.5` (echo-pass passed,
echo-fail failed deterministically); a missing-golden request returned **HTTP 400** via the error branch.
