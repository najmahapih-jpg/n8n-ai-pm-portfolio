# Workflow Contract

## Workflow

- Name: `Portfolio - Support Triage API`
- Version: `0.3.0`
- Primary entry point: `POST /webhook/portfolio/support-triage`
- Other entry points: none in the current workflow
- Default mode: deterministic local workflow; Feishu notification is optional and outbound-only
- Source of truth: `workflows/sdk/portfolio-support-triage-api.workflow.js`
- Release snapshot: `workflows/releases/support-triage-v0.3.0.json`

## Purpose

Receive a support ticket, normalize aliases, validate required fields, classify category, score urgency, route the owning team, compute SLA, optionally notify Feishu, create a redacted audit event, and return a safe structured response.

## Input Contract

Accepted content type: JSON.

Required logical fields:

- `customerEmail` or `email`
- `subject` or `title`
- `message` or `description`

Optional fields and aliases:

- `plan` or `customerTier`
- `receivedAt`
- `source`
- `accountId` or `customerId`

Normalization rules:

- `email` maps to `customerEmail`.
- `title` maps to `subject`.
- `description` maps to `message`.
- `customerId` maps to `accountId`.

Example:

```json
{
  "customerEmail": "ops@example.com",
  "subject": "Enterprise incident",
  "message": "Checkout is down for our enterprise account.",
  "plan": "enterprise",
  "receivedAt": "2026-05-27T12:00:00Z",
  "source": "webhook",
  "accountId": "acct_demo"
}
```

## Operational Limits

- Supported public JSON body size: 64 KB maximum. Deployments should reject larger payloads before invoking the workflow.
- String limits: email 254 characters, subject/title 200 characters, message/description 8,000 characters, `source` 64 characters, and account/customer ids 128 characters.
- Item count: one ticket per request. Batch inputs are outside the public contract.
- Idempotency: the workflow does not deduplicate tickets. Callers that need replay protection should supply stable upstream identifiers (`accountId`/`customerId`, `receivedAt`, and their own request id) and enforce duplicate suppression before calling the webhook.
- Feishu delivery timeout: 10,000 ms on the outbound HTTP node. The current workflow does not retry Feishu sends; delivery failure is represented in `feishuDelivery` and must not hide the triage result.
- Public callers must not provide `feishuWebhookUrl` or `feishuSigningSecret`; those values are deployment/runtime configuration only and must be stripped or rejected at the gateway.

## Output Contract

Successful responses return HTTP 200 with a safe triage payload:

```json
{
  "ok": true,
  "ticketId": "ticket_...",
  "traceId": "trace-...",
  "category": "incident|billing|account|bug|general",
  "urgency": "critical|high|normal|low",
  "urgencyScore": 0,
  "routingTeam": "support-ops",
  "slaHours": 4,
  "dueAt": "2026-05-27T16:00:00.000Z",
  "escalationRequired": true,
  "handlingPath": "escalated|standard",
  "auditEventId": "audit_...",
  "policyVersion": "supportops-triage-v0.3.0-local-feishu",
  "feishuDelivery": {
    "configured": false,
    "signed": false,
    "status": "skipped|sent|failed",
    "statusCode": null,
    "reason": "FEISHU_BOT_WEBHOOK_URL is not set"
  }
}
```

The response must not include Feishu webhook URLs, signing secrets, raw credentials, Authorization headers, cookies, or private n8n URLs.

## Error Contract

Validation failure returns an error response instead of a partial triage result:

```json
{
  "ok": false,
  "error": "Missing required fields",
  "missingFields": ["customerEmail"],
  "traceId": "trace-invalid",
  "policyVersion": "supportops-triage-v0.3.0-local-feishu"
}
```

Expected status behavior:

- Missing any required logical field after alias normalization: HTTP 400.
- Valid payloads: HTTP 200.
- Feishu delivery failure must not hide the triage result; `feishuDelivery.status` carries the delivery outcome.

## External Integrations

- Feishu custom bot webhook: optional outbound notification only.
- Required environment variables for live Feishu sends:
  - `FEISHU_BOT_WEBHOOK_URL`
  - `FEISHU_BOT_SIGNING_SECRET` (optional)

## Security and Privacy Boundary

- Treat all webhook input as untrusted.
- Do not store real customer messages in fixtures.
- Do not commit Feishu webhook URLs or signing secrets.
- Do not accept caller-supplied outbound webhook URLs or signing secrets on a public endpoint.
- Feishu card payloads must contain only summary, routing, SLA, `traceId`, and `auditEventId`; do not send raw credentials or full private payloads.
- Public deployment must add authentication or signed request verification, TLS, rate limits, request size limits, and replay protection outside this local workflow.

See `docs/security-boundaries.md` for the full boundary checklist.

## Contract Tests

Primary fixtures:

- `fixtures/pin-data/support-triage-enterprise-incident.json`
- `fixtures/pin-data/support-triage-urgent-incident.json`
- `fixtures/pin-data/support-triage-billing.json`
- `fixtures/pin-data/support-triage-account-alias.json`
- `fixtures/pin-data/support-triage-bug.json`
- `fixtures/pin-data/support-triage-general.json`
- `fixtures/pin-data/support-triage-invalid-date.json`
- `fixtures/pin-data/support-triage-missing-field.json`

Required gates:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

Live Feishu verification is opt-in and requires local runtime credentials.
