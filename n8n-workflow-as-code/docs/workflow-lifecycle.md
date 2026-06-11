# Workflow Lifecycle

1. Capture the requirement in `fixtures/requests`.
2. Search templates first with community n8n-mcp.
3. Search node schemas and examples with community n8n-mcp.
4. Configure every behavior-controlling node parameter explicitly.
5. Validate each non-trivial node configuration.
6. Validate the complete workflow JSON before deployment.
7. Validate the workflow through official n8n MCP before create/update.
8. Create or update the local n8n draft through official n8n MCP.
9. Prepare pin data and run `test_workflow`.
10. Export workflows through the n8n Docker server CLI or API path into an ignored raw/generated timestamp directory.
11. Scrub exported JSON into `workflows/canonical`.
12. Maintain `workflows/sdk/<slug>.meta.json`.
13. Generate `docs/registry/workflow-registry.md` and `docs/registry/index.json`.
14. Run static JSON validation, registry freshness checks, and smoke tests.
15. Commit only scrubbed canonical JSON, release snapshots, metadata, fixtures, prompts, scripts, and docs.
16. Create a release snapshot after successful demo verification.

## Dated Decision Notes

### 2026-05-28: Official MCP Owns Writes

Use official n8n MCP as the normal workflow writer because it consumes the Workflow SDK source path used by this repository and keeps create/update/test operations on one authoritative surface.

Rejected: community n8n-mcp as a simultaneous writer | it is excellent for node/template research, but two writable MCPs against the same local instance create avoidable race and ownership risk.

### 2026-05-28: Git Stores Scrubbed Artifacts Only

Commit Workflow SDK source, canonical scrubbed JSON, and release snapshots. Do not commit raw exports, execution payloads, credential references, private webhook URLs, or local `.env` files.

Rejected: commit direct n8n exports as the source of truth | raw exports are noisy, include instance metadata, and are harder to review than SDK source.

### 2026-05-28: Local Feishu Is Outbound-Only

Keep Feishu integration as local outbound custom bot notifications until a requirement needs inbound callbacks. This avoids deployment, public webhook exposure, and app-level callback verification work while still proving a real integration path.

Rejected: bidirectional Feishu bot in this project phase | event subscriptions and card callbacks require a public callback URL or tunnel and add operational scope beyond the portfolio workflow.

### 2026-05-28: Registry Is Generated

Use per-workflow metadata plus canonical JSON to generate both the human registry and the machine-readable index. This keeps docs, CI checks, and future agent search grounded in the same data.

Rejected: maintain registry rows by hand | manual rows drift when node counts, releases, fixtures, or workflow status change.
