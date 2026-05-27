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

No failover or maintenance-profile decisions recorded yet.
