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
- Upgraded `Portfolio - Support Triage API` to a 21-node SupportOps incident triage workflow.
- Added multi-path fixtures for enterprise incident, urgent incident, billing, account alias, bug, general, invalid-date, and missing-field scenarios.
- Added tracked workflow SDK source for reviewable official MCP updates.
- Added API draft export and minimum-node JSON validation so enhanced draft snapshots cannot regress to the old 4-node export unnoticed.
- Added source-to-artifact SDK sync automation and an 8-case official MCP regression suite covering account, bug, urgent, alias, invalid-date, and audit-redaction behavior.
