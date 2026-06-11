# Lead Intelligence Design

## Objective

Create a second engineering-grade n8n Workflow-as-Code project under `C:\Dev\Projects` that is more resume-worthy than a simple notification workflow and can be tested locally without deployment.

## Selected Workflow

`Portfolio - Lead Intelligence API`

## Acceptance Criteria

- Official MCP can validate and create/update the workflow from SDK source.
- The workflow has at least 38 nodes and multiple meaningful branches.
- Canonical and release JSON are scrubbed and committed.
- Static validation, smoke, and full live MCP pin-data regression tests pass.
- External CRM and Feishu/Lark configuration is deferred to the final adapter phase.

## Core Behaviors

- Lead intake normalization.
- Required-field validation.
- Email syntax validation.
- Duplicate detection.
- Deterministic local enrichment.
- ICP, intent, and priority scoring.
- A-D grade assignment.
- Sales owner routing.
- Follow-up SLA generation.
- CRM-ready payload generation.
- Hot-lead notification contract.
- Redacted audit event generation.
