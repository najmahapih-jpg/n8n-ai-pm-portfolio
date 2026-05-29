# Lead Intelligence Workflow Request

Build a local-first n8n workflow that accepts B2B lead intake payloads and returns a deterministic sales routing decision suitable for portfolio review.

## Required Behavior

- Accept POST webhook payloads at `portfolio/lead-intelligence`.
- Normalize common aliases such as `workEmail`, `customerEmail`, `company`, `accountName`, `product`, and `interest`.
- Validate required fields: email, company name, and at least one intent source (`message`, `requestedProduct`, or `intentSignals`).
- Reject malformed email addresses with HTTP 422.
- Detect duplicate leads through an explicit `existingLeadId` or known duplicate domains.
- Enrich locally with deterministic company and intent rules, without external APIs.
- Score ICP fit, intent strength, and combined priority.
- Assign grades A, B, C, or D and route to owner queues.
- Build a CRM-ready payload while returning only a safe response subset.
- Emit a redacted audit event that never contains raw email or raw message content.
- Keep external CRM and Feishu notification adapters as final optional configuration, not part of the v0.1 acceptance path.

## Portfolio Value

This workflow demonstrates workflow-as-code, deterministic rule engines, data normalization, branching validation, idempotency, PII redaction, sales routing, pin-data regression tests, canonical release snapshots, and local n8n MCP automation.
