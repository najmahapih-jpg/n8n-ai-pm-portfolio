# Architecture

## System Roles

- Git repository: source of truth for scrubbed workflows, fixtures, prompts, scripts, and docs.
- Local n8n Docker instance: runtime for draft creation, workflow validation, test execution, and publish checks.
- Official n8n MCP: authoritative writer for local workflow create, update, validate, test, execute, publish, and unpublish operations.
- Community n8n-mcp: design-time assistant for templates, node documentation, node configuration examples, node validation, and workflow pre-validation.
- PowerShell scripts: repeatable local connection checks, export, scrub, and static validation.
- Workflow metadata and registry: per-workflow `.meta.json` files plus generated Markdown/JSON indexes for human review and agent search.

## Data Flow

Requirement markdown -> template/node research -> workflow SDK source + metadata -> community validation -> official MCP validation -> local n8n draft -> pin-data test -> API/CLI export -> scrub -> canonical JSON -> release snapshot -> generated registry/index -> smoke test.

## Runtime Boundary

The n8n instance can contain live credentials and execution history. The Git repository cannot contain live credentials, raw execution data, decrypted credentials, raw exported workflows, Authorization headers, cookies, or private webhook URLs.

## Local Runtime Requirements

- Docker Desktop running.
- n8n container available locally, normally named `n8n`.
- `/home/node/.n8n` persisted with a Docker volume or bind mount.
- Postgres configured for durable workflow data.
- Fixed `N8N_ENCRYPTION_KEY` configured and never recorded in this repository.
- Dangerous local execution nodes excluded through `NODES_EXCLUDE`.
- Task runner sidecar used when Code node execution is needed.

## Source-of-Truth Rule

The n8n instance is the runtime truth for draft execution. The repository is the review and release truth for scrubbed workflow definitions. Raw exports are intermediate artifacts and must remain ignored.
