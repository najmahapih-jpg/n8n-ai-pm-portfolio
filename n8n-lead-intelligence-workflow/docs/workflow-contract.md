# Workflow Contract

## Workflow

- Name: `Portfolio - Lead Intelligence API`
- Version: `0.1.2`
- Primary entry point: `POST /webhook/portfolio/lead-intelligence`
- Editor entry point: manual trigger demo
- Agent/tool entry point: Execute Workflow Trigger / MCP tool entry
- Default mode: deterministic local scoring, no external CRM or Feishu calls
- Source of truth: `workflows/sdk/lead-intelligence.workflow.js`
- Tool workflow source: `workflows/sdk/lead-scoring-mcp-tool.workflow.js`
- Release snapshot: `workflows/releases/lead-intelligence-v0.1.2.json`

## Purpose

Accept a B2B lead intake payload, normalize common field aliases, validate the lead, score ICP fit and intent, route the owner queue, produce a CRM-ready payload subset, create a redacted audit event, and return a safe sales routing decision.

## Input Contract

Accepted content type: JSON.

Required logical fields:

- `email` or `workEmail` or `customerEmail`
- `companyName` or `company` or `accountName`
- At least one intent source:
  - `message`
  - `requestedProduct` or `product` or `interest`
  - `intentSignals` or `signals` or `intent`

Optional fields:

- `fullName`
- `title` or `jobTitle`
- `companyDomain` or `domain`
- `source` or `channel`
- `industry`
- `country` or `region`
- `employeeCount` or `employees` or `companySize`
- `annualRevenue` or `revenue`
- `plan`
- `manualGrade` or `overrideGrade`
- `existingLeadId`
- `receivedAt`
- `traceId` or `requestId` (optional correlation id; captured and echoed, never generated — see Correlation below)

Example:

```json
{
  "email": "buyer@example.com",
  "companyName": "Example Corp",
  "companyDomain": "example.com",
  "requestedProduct": "Enterprise AI",
  "message": "We need an enterprise rollout plan.",
  "intentSignals": ["demo_request", "pricing"],
  "employeeCount": 1200,
  "industry": "software",
  "country": "us"
}
```

## Operational Limits

- NOTE: the size/string/item limits in this section are **not enforced in-workflow** (the workflow only coerces and trims inputs); they are the caps a deployment gateway should enforce in front of the public webhook.
- Supported public JSON body size: 64 KB maximum. Deployments should reject larger payloads before invoking the workflow.
- String limits: email 254 characters, company/domain/name/title fields 256 characters, free-text `message` 8,000 characters, and source/channel fields 64 characters.
- Item count: one lead per request. `intentSignals`/`signals` may contain up to 20 short string items; larger batches are outside the public contract.
- Idempotency: `existingLeadId` and deterministic duplicate-domain handling are the current replay/duplicate indicators. The generated `crmPayload.idempotencyKey` is non-secret and is the key future CRM adapters must use for write retries.
- External calls: none in the current workflow. Future CRM, Feishu, or enrichment adapters must be opt-in, use a maximum 10 second timeout per call, retry at most once, and only retry writes with an idempotency key.
- Public deployment must still add authentication, rate limiting, and replay controls outside the workflow.

## Output Contract

Successful responses return a safe response object:

```json
{
  "ok": true,
  "leadId": "lead_...",
  "traceId": "trace-abc-123 | null",
  "companyName": "Example Corp",
  "grade": "A|B|C|D",
  "priorityScore": 88,
  "icpFitScore": 40,
  "intentScore": 48,
  "route": {
    "ownerQueue": "enterprise-ae",
    "ownerTeam": "enterprise-sales",
    "reason": "high fit and high intent"
  },
  "followUp": {
    "slaHours": 4,
    "dueAt": "2026-05-29T16:00:00.000Z",
    "hotLead": true,
    "playbook": "same-day executive AE follow-up"
  },
  "crmPayload": {
    "externalId": "lead_...",
    "idempotencyKey": "...",
    "ownerQueue": "enterprise-ae",
    "grade": "A"
  },
  "auditEventId": "audit_...",
  "policyVersion": "lead-intel-v0.1.0"
}
```

The response must not include raw email hashes that are reversible, raw messages beyond safe summaries, CRM API keys, Feishu webhook URLs, or n8n management credentials.

### Correlation (optional `traceId`)

- A caller (or upstream gateway) may supply an optional correlation id as `traceId`, falling back to `requestId` when `traceId` is absent.
- The workflow **captures and echoes** this value: it is **never generated** in-workflow (no random/UUID), so the deterministic offline differential stays reproducible.
- On the successful lead path it surfaces as `response.traceId` and on the redacted `auditEvent.traceId`, letting a caller correlate the response and the audit record to the originating request.
- When neither `traceId` nor `requestId` is supplied, both fields are `null` — purely additive, with no other change to the response or audit event (the deterministic `leadId`/`idempotencyKey`/`auditEventId` hashes are unaffected by `traceId`).
- The duplicate (200) and error (400/422) responses do not carry `traceId`; correlation is scoped to the scored lead response and its audit event.

## Error Contract

Expected validation behavior:

- Missing required logical fields: HTTP 400 with a validation response.
- Malformed email: HTTP 422.
- Duplicate lead signals are represented in scoring/routing rather than silently ignored.

The error response must include `ok:false`, a machine-readable error label, `missingFields` when applicable, and `policyVersion`.

## External Integrations

Current workflow:

- No external CRM write.
- No live Feishu send.
- Produces CRM-ready and notification-ready objects only.

Future adapters must remain opt-in and must follow `docs/security-boundaries.md`.

## Security and Privacy Boundary

- Email and message content are PII-bearing inputs.
- Audit events must never contain raw email or raw message content.
- Idempotency keys and lead IDs must be non-secret and non-reversible.
- CRM and Feishu credentials stay runtime-only when adapters are added.
- The Execute Workflow / MCP tool entry must preserve the same input, output, and redaction rules as the webhook entry.

## Contract Tests

Primary fixtures:

- `fixtures/pin-data/lead-hot-enterprise.json`
- `fixtures/pin-data/lead-midmarket-qualified.json`
- `fixtures/pin-data/lead-high-intent-low-fit.json`
- `fixtures/pin-data/lead-student-low-fit.json`
- `fixtures/pin-data/lead-low-intent-newsletter.json`
- `fixtures/pin-data/lead-competitor-domain.json`
- `fixtures/pin-data/lead-bad-email.json`
- `fixtures/pin-data/lead-missing-company.json`
- `fixtures/pin-data/lead-duplicate-domain.json`
- `fixtures/pin-data/lead-duplicate-existing-id.json`
- `fixtures/pin-data/lead-manual-override.json`
- `fixtures/pin-data/lead-traceid-correlation.json`

Required gates:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

`npm run verify:live` requires a local n8n runtime and MCP/API credentials.

## Machine-readable contract

Parsed by `n8n-contract-test-runner` (`Test-Contract.ps1`). `request.limits` are **gateway-delegated**.

```json
{
  "contractVersion": "lead-intel-v0.1.0",
  "webhookPath": "webhook/portfolio/lead-intelligence",
  "request": {
    "accepted": ["email", "workEmail", "customerEmail", "companyName", "company", "accountName", "message", "requestedProduct", "product", "interest", "intentSignals", "signals", "intent", "fullName", "title", "jobTitle", "companyDomain", "domain", "source", "channel", "industry", "country", "region", "employeeCount", "employees", "companySize", "annualRevenue", "revenue", "plan", "manualGrade", "overrideGrade", "existingLeadId", "receivedAt", "traceId", "requestId"],
    "oneOfRequired": [["email", "workEmail", "customerEmail"], ["companyName", "company", "accountName"]],
    "limits": { "bodyBytes": 65536, "messageChars": 8000 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["ok", "leadId", "companyName", "grade", "priorityScore", "icpFitScore", "intentScore", "route", "followUp", "auditEventId", "policyVersion"],
    "types": { "ok": "boolean", "grade": "string", "priorityScore": "number", "policyVersion": "string" }
  },
  "errors": [
    { "when": "missing required field", "status": 400, "responseRequired": ["ok"], "okValue": false }
  ],
  "fixtures": {
    "dir": "fixtures/pin-data",
    "valid": ["lead-competitor-domain.json", "lead-duplicate-domain.json", "lead-duplicate-existing-id.json", "lead-high-intent-low-fit.json", "lead-hot-enterprise.json", "lead-low-intent-newsletter.json", "lead-manual-override.json", "lead-student-low-fit.json", "lead-traceid-correlation.json"],
    "errorCases": ["lead-bad-email.json", "lead-missing-company.json"]
  }
}
```
