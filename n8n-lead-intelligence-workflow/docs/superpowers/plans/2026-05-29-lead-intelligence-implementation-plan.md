# Lead Intelligence Implementation Plan

## Plan

1. Copy the existing Workflow-as-Code scaffold into `C:\Dev\Projects\n8n-lead-intelligence-workflow`.
2. Remove support-triage workflow artifacts.
3. Add `lead-intelligence.workflow.js` and metadata.
4. Add deterministic pin-data fixtures.
5. Add live MCP regression script.
6. Add workflow-specific JSON guard.
7. Update sync, smoke, static validation, npm scripts, and environment example.
8. Sync through official n8n MCP to create the local draft.
9. Export, scrub, and snapshot release JSON.
10. Generate registry files.
11. Rewrite docs for the new workflow.
12. Run `npm run verify:static`, `npm run smoke`, and `npm run verify:live`.
13. Commit with a Lore protocol message.
