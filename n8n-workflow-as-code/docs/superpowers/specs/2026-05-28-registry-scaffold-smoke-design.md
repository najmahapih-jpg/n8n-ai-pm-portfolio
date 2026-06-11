# Registry, Scaffold, and Smoke Test Design

## Goal

Complete the non-Feishu production-readiness gaps before touching live Feishu configuration.

## Scope

This pass adds:

- Per-workflow metadata beside Workflow SDK source files.
- A generated Markdown registry for humans and JSON index for agents/tools.
- A scaffold script for the next workflow.
- A single-command smoke test that runs static checks, local n8n connectivity, and one representative workflow case.

Feishu live-send configuration stays last. The default smoke path keeps `FeishuMode=skipped`, so it does not send messages.

## Architecture

`workflows/sdk/<slug>.meta.json` stores stable metadata such as owner, status, release snapshot, fixtures, and smoke cases. `scripts/Build-WorkflowIndex.ps1` combines metadata with canonical workflow JSON to produce `docs/registry/workflow-registry.md` and `docs/registry/index.json`.

`scripts/New-N8nWorkflowScaffold.ps1` creates a minimal SDK workflow, metadata file, request brief, and smoke fixture for future workflows. `scripts/Invoke-SmokeTest.ps1` is the operator-facing smoke command and intentionally keeps Feishu send assertions opt-in.

## Validation

Static validation checks registry freshness. Smoke validation runs after static checks and before any Feishu live-send configuration.
