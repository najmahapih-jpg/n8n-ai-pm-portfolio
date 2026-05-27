# MCP Policy

## One-Writer Rule

Only the official n8n MCP writes to the local n8n instance during normal work.

For normal Codex or Claude design sessions, community n8n-mcp should be configured without `N8N_API_URL` and `N8N_API_KEY`. This keeps its workflow-management tools unavailable and leaves only documentation, template, node discovery, and validation tools.

## Allowed Official n8n MCP Operations

- `search_workflows`
- `get_workflow`
- `validate_workflow`
- `create_workflow_from_code`
- `update_workflow`
- `prepare_test_pin_data`
- `test_workflow`
- `execute_workflow`
- `publish_workflow`
- `unpublish_workflow`
- `archive_workflow`

## Allowed Community n8n-mcp Operations

- `tools_documentation`
- `search_templates`
- `get_template`
- `search_nodes`
- `get_node`
- `validate_node`
- `validate_workflow`
- documentation and schema lookup operations

## Disallowed By Default

- Using community `n8n_create_workflow`, `n8n_update_full_workflow`, `n8n_update_partial_workflow`, or `n8n_delete_workflow` when official MCP is available.
- Running official MCP and community n8n-mcp as simultaneous writable management surfaces in the same agent session.
- Publishing a workflow before validation and pin-data testing.
- Editing production workflows directly with AI.
- Allowing AI agents to create, rotate, delete, or reveal credentials.

## Failover Rule

If official MCP is unavailable, community n8n-mcp management tools may be used only in a separate maintenance profile after the operator records the reason in `docs/workflow-lifecycle.md` under a dated decision note.

## Secret Rule

No agent may print or commit `N8N_API_KEY`, `N8N_MCP_TOKEN`, credential payloads, decrypted credential exports, Authorization headers, cookies, or private webhook URLs.

## Concurrency Rule

Codex and Claude must not modify the same workflow at the same time. Prefer a staging project or folder named `MCP Staging` or `AI Drafts`, and record workflow IDs in `docs/registry/workflow-registry.md` before publishing.
