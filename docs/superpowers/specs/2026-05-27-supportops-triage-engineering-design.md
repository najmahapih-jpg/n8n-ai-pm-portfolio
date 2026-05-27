# SupportOps Triage Engineering Design

## Goal

Upgrade `Portfolio - Support Triage API` from a minimal webhook demo into an engineering-grade local n8n workflow that demonstrates workflow design, branching, state shaping, deterministic policy decisions, auditability, export/scrub/version control, and repeatable tests without relying on external credentials.

## Non-Goals

- Do not publish the workflow yet.
- Do not add paid SaaS or LLM credentials.
- Do not use community n8n-mcp as a writer.
- Do not move secrets, raw exports, or execution logs into Git.

## Workflow Shape

The workflow becomes a SupportOps incident triage pipeline:

1. Receive ticket through webhook.
2. Normalize inbound payload.
3. Validate required fields.
4. Return structured 400 errors for invalid payloads.
5. Generate ticket identity and tracking metadata.
6. Redact PII for logs and audit events.
7. Classify category.
8. Score urgency.
9. Route owning team.
10. Compute SLA policy.
11. Branch on escalation need.
12. Build escalation payload or standard handling payload.
13. Create an audit event.
14. Build the customer response.
15. Return structured 200 response.

## Node-Level Responsibilities

- `Receive Support Ticket`: HTTP POST webhook.
- `Normalize Payload`: Converts body/direct JSON variants into one internal shape.
- `Validate Required Fields`: IF node that branches on `isValid`.
- `Build Validation Error`: Creates `400` response with missing fields and trace ID.
- `Return Validation Error`: Responds to webhook for invalid requests.
- `Generate Ticket Metadata`: Adds deterministic `ticketId`, `traceId`, and timestamps.
- `Redact Customer PII`: Masks email and limits message preview for logging.
- `Classify Ticket Category`: Classifies `incident`, `billing`, `account`, `bug`, or `general`.
- `Score Urgency`: Computes numeric urgency score and urgency label.
- `Route Owning Team`: Maps category and urgency to owning team.
- `Build SLA Policy`: Adds SLA hours, due timestamp, breach risk, and policy version.
- `Escalation Needed?`: IF node for urgent enterprise/incident/payment cases.
- `Build Escalation Payload`: Creates paging/audit payload for escalated cases.
- `Build Standard Handling Payload`: Creates normal queue payload.
- `Create Audit Event`: Creates a safe, redacted audit event.
- `Build Customer Response`: Creates stable API response.
- `Return Triage Response`: Responds with `200`.

## Test Fixtures

Add eight synthetic payloads:

- `support-triage-enterprise-incident.json`: urgent enterprise incident.
- `support-triage-missing-field.json`: invalid payload, returns 400 branch.
- `support-triage-billing.json`: billing category, high urgency, billing route.
- `support-triage-general.json`: normal category, general-support route.
- `support-triage-account-alias.json`: direct JSON payload using alias fields.
- `support-triage-bug.json`: bug category, product-engineering route.
- `support-triage-urgent-incident.json`: urgent but non-critical incident.
- `support-triage-invalid-date.json`: invalid `receivedAt` with SLA fallback.

## Acceptance Criteria

- Workflow has at least 21 nodes.
- Official MCP `validate_workflow` passes before update.
- Official MCP `update_workflow` succeeds against the existing local workflow.
- Official MCP regression tests pass for all 8 current pin-data paths.
- SDK source sync updates the draft, exports it through the API, scrubs canonical JSON, and copies the `v0.2.0` release snapshot.
- Export, scrub, canonical validation, and release validation pass.
- `workflows/canonical/portfolio-support-triage-api.canonical.json` contains the enhanced workflow.
- `workflows/releases/support-triage-v0.2.0.json` exists and validates.
- README and demo docs describe the enhanced engineering-grade workflow.

## Residual Risks

- Code nodes remain in use for deterministic policy transformations because this local v0.2.0 workflow intentionally avoids external services and database writes.
- Runtime correctness is validated through official MCP pin-data tests, not production webhook calls.
- Publishing remains intentionally out of scope until the user asks for production activation.
