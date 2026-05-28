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
10. Export workflows through the n8n Docker server CLI into an ignored raw/generated timestamp directory.
11. Scrub exported JSON into `workflows/canonical`.
12. Run static JSON validation.
13. Commit only scrubbed canonical JSON, fixtures, prompts, scripts, and docs.
14. Create a release snapshot after successful demo verification.

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
