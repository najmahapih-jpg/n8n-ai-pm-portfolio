# Workflow Contract

## Workflow

- Name: `Portfolio - Product Feedback Intelligence API`
- Version: `0.2.0` release snapshot, workflow policy `feedback-intel-v0.1.0`
- Primary entry point: `POST /webhook/portfolio/product-feedback-intelligence`
- Editor entry point: manual trigger demo
- Default mode: deterministic stub classifier
- Source of truth: `workflows/sdk/product-feedback-intelligence.workflow.js`
- Release snapshot: `workflows/releases/product-feedback-intelligence-v0.2.0.json`

## Purpose

Classify free-text product feedback into a fixed taxonomy, derive sentiment and urgency, score priority, gate churn-risk or critical feedback for human review, create a redacted audit event, and return a safe structured product signal.

## Input Contract

Accepted content type: JSON.

Required logical field:

- `feedbackText` or `text` or `message` or `comment`

Optional fields:

- `reportedCount` or `count`
- `source` or `channel`
- `submittedAt` or `createdAt`
- `classifierMode`: `stub` (default) or `ollama`

Example:

```json
{
  "feedbackText": "The export button crashes on Safari and we may cancel.",
  "reportedCount": 3,
  "source": "support",
  "submittedAt": "2026-05-29T12:00:00Z",
  "classifierMode": "stub"
}
```

## Operational Limits

- Supported public JSON body size: 64 KB maximum. Deployments should reject larger payloads before invoking the workflow.
- String limits: feedback text 8,000 characters, source/channel 64 characters, and timestamp strings 64 characters.
- Item count: one feedback item per request. Batch classification is outside the current public contract.
- `reportedCount` should be a non-negative integer and is only a scoring hint.
- Idempotency: `feedbackId` is generated per accepted request and the workflow performs no external write. Upstream systems that replay the same feedback must deduplicate before calling the webhook.
- Ollama classifier timeout: 60,000 ms. The current workflow does not retry live classifier calls; invalid or unreachable classifier output falls back to deterministic classification.
- Public deployment must add authentication, rate limiting, request size enforcement, and replay controls outside the workflow.

## Output Contract

Successful responses return a safe response object:

```json
{
  "ok": true,
  "status": "classified|awaiting_approval",
  "needsHumanReview": false,
  "feedbackId": "feedback_...",
  "theme": "bug|feature_request|usability|performance|pricing|praise|churn_risk|other",
  "sentiment": "positive|neutral|negative",
  "urgency": "critical|high|normal|low",
  "priorityScore": 12,
  "classifierSource": "stub|ollama|fallback",
  "safeExcerpt": "The export button crashes...",
  "auditEventId": "audit_...",
  "policyVersion": "feedback-intel-v0.1.0"
}
```

Human-review routing:

- `theme:"churn_risk"` or `urgency:"critical"` returns `needsHumanReview:true` and `status:"awaiting_approval"`.
- Other valid cases return `needsHumanReview:false`.

## Error Contract

Expected status behavior:

- Missing feedback field: HTTP 400 with `ok:false` and `error:"Missing required feedback field"`.
- Empty or whitespace feedback text: HTTP 422 with `ok:false` and `error:"Empty feedback text"`.

## External Integrations

- `classifierMode:"stub"`: deterministic keyword classifier; default and CI-safe.
- `classifierMode:"ollama"`: local live LLM classifier via Ollama; opt-in per request.
- Feishu/CRM delivery is deferred and not part of the current acceptance path.

## Security and Privacy Boundary

- Feedback text may contain PII and must be minimized in outputs.
- Audit event must not contain raw feedback text beyond safe excerpts.
- Email-like tokens embedded in feedback must be masked before audit.
- LLM classifier output must pass schema and confidence checks; low-confidence or invalid output must fall back to deterministic classification.
- The model never directly sets urgency; urgency is derived deterministically.

## Contract Tests

Primary fixtures:

- `fixtures/pin-data/feedback-bug-negative.json`
- `fixtures/pin-data/feedback-churn-risk.json`
- `fixtures/pin-data/feedback-feature-request.json`
- `fixtures/pin-data/feedback-low-confidence-fallback.json`
- `fixtures/pin-data/feedback-missing-text.json`
- `fixtures/pin-data/feedback-performance.json`
- `fixtures/pin-data/feedback-praise.json`
- `fixtures/pin-data/feedback-pricing.json`
- `fixtures/pin-data/feedback-prompt-injection.json`
- `fixtures/pin-data/feedback-usability.json`

Required gates:

```powershell
npm run verify:static
npm run verify:json
npm run smoke
```

Live verification requires local n8n and MCP credentials.
