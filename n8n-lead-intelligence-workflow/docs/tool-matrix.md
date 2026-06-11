# MCP Tool Matrix

| Tool Surface | Normal Profile | Authentication | Primary Use | Writes Instance? |
| --- | --- | --- | --- | --- |
| Official n8n MCP | Enabled | `N8N_MCP_TOKEN` | Validate, create, update, test, publish local workflows | Yes |
| Community n8n-mcp | Docs/design only | No `N8N_API_URL` or `N8N_API_KEY` in normal sessions | Templates, node docs, schema lookup, pre-validation | No |
| Community n8n-mcp maintenance profile | Disabled by default | `N8N_API_URL` and `N8N_API_KEY` only in separate session | Emergency maintenance, template deployment, rollback research | Yes, only when explicitly chosen |
| n8n REST API | Local scripts | `N8N_API_KEY` | Export current workflow drafts for scrubbed versioning | Reads workflow definitions |
| n8n Docker server CLI | Local scripts | Docker access | Bulk fallback export for operator backups | Reads workflow definitions |

## Naming Rule

When an agent has multiple MCP servers available, every operation must name the intended server in the reasoning notes and final summary. Similar tool names are not interchangeable.

## Minimum Runtime Expectations

- n8n local instance reachable at `http://localhost:5678`.
- Official MCP endpoint reachable at `/mcp-server/http`.
- Workflow updates use official MCP as the normal writer.
- Normal sync exports use the n8n REST API, then scrub before writing canonical or release files.
