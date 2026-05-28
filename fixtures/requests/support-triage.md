# Workflow Request

## Name

Portfolio - Support Triage API

## Business Outcome

Receive support tickets through a webhook, normalize payload variants, validate required fields, classify ticket category, score urgency, route to the owning team, compute SLA policy, branch escalation, create a redacted audit event, and return a structured response.
For escalated tickets, optionally send a Feishu group bot alert when local Feishu environment variables are configured.

## Trigger

HTTP POST webhook at `/portfolio/support-triage`.

## Inputs

- `customerEmail`
- `subject`
- `message`
- `plan`
- `receivedAt`
- `source`
- `accountId`

## Outputs

- `ticketId`
- `urgency`
- `summary`
- `category`
- `urgencyScore`
- `routingTeam`
- `slaHours`
- `dueAt`
- `escalationRequired`
- `handlingPath`
- `auditEventId`
- `feishuDelivery`

## External Services

Optional Feishu custom bot webhook for local outbound group notifications.

## Credentials Required

No n8n credential is required for default tests. Live Feishu sends require local `FEISHU_BOT_WEBHOOK_URL` and optionally `FEISHU_BOT_SIGNING_SECRET`.

## Test Data

Use:

- `fixtures/pin-data/support-triage-enterprise-incident.json`
- `fixtures/pin-data/support-triage-urgent-incident.json`
- `fixtures/pin-data/support-triage-billing.json`
- `fixtures/pin-data/support-triage-account-alias.json`
- `fixtures/pin-data/support-triage-bug.json`
- `fixtures/pin-data/support-triage-general.json`
- `fixtures/pin-data/support-triage-invalid-date.json`
- `fixtures/pin-data/support-triage-missing-field.json`

## Error Handling

Return HTTP 400 when `customerEmail`, `subject`, or `message` is missing. Return HTTP 200 with triage output for valid requests.

## Privacy and Security Notes

Do not store full customer messages in Git fixtures beyond synthetic examples.

## Done Criteria

- Draft workflow exists in local n8n.
- Official MCP validation passes.
- Pin-data tests pass for enterprise incident, urgent incident, billing, account alias, bug, general, invalid-date, and missing-field paths.
- Exported workflow is scrubbed and saved in `workflows/canonical`.
- Release snapshot exists as `workflows/releases/support-triage-v0.3.0.json`.
