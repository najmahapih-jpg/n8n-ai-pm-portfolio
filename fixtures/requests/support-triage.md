# Workflow Request

## Name

Portfolio - Support Triage API

## Business Outcome

Receive support tickets through a webhook, classify urgency, normalize fields, return a structured response, and record enough metadata for later storage integration.

## Trigger

HTTP POST webhook at `/portfolio/support-triage`.

## Inputs

- `customerEmail`
- `subject`
- `message`
- `plan`
- `receivedAt`

## Outputs

- `ticketId`
- `urgency`
- `summary`
- `routingTeam`
- `slaHours`

## External Services

None in MVP. Use deterministic logic first. Add LLM classification in a later workflow version after credential handling is documented.

## Credentials Required

None in MVP.

## Test Data

Use `fixtures/pin-data/support-triage-input.json`.

## Error Handling

Return HTTP 400 when `customerEmail`, `subject`, or `message` is missing. Return HTTP 200 with triage output for valid requests.

## Privacy and Security Notes

Do not store full customer messages in Git fixtures beyond synthetic examples.

## Done Criteria

- Draft workflow exists in local n8n.
- Official MCP validation passes.
- Pin-data test passes.
- Exported workflow is scrubbed and saved in `workflows/canonical`.
