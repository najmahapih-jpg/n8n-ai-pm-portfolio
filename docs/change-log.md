# Change Log

## 2026-05-27

- Created the local Workflow-as-Code project skeleton.
- Added MCP one-writer policy.
- Added first workflow request and pin-data fixture.
- Added PowerShell scripts for local connection checks, workflow export, scrub, and offline validation.
- Removed n8n API credentials from the default community n8n-mcp Codex config so the community server runs as a docs/design helper by default.
- Added `NODES_EXCLUDE` to the local n8n Docker Compose runtime to block command execution and local file read/write nodes.
- Created and tested `Portfolio - Support Triage API` through official n8n MCP.
- Exported, scrubbed, validated, and released the first canonical workflow JSON.
