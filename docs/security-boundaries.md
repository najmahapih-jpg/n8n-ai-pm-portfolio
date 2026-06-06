# Security and Privacy Boundaries

This document is the required design review surface for interfaces, credentials, security functions, external adapters, and data persistence in this n8n Workflow-as-Code project.

It is intentionally conservative: repository artifacts are public-reviewable, while live credentials, private webhook URLs, raw execution history, and customer-like payloads remain local runtime data.

This gateway is the production-edge control layer for the portfolio. Its purpose is to enforce HMAC authentication, body-size limits, secret-stripping, and intent-allowlist routing in front of all sibling workflows. Security-function changes here have broad impact and must be reviewed carefully.

## Security Goals

- Keep the Git repository free of secrets, private webhook URLs, raw live execution data, Authorization headers, cookies, and decrypted n8n credentials.
- Keep stub/offline mode safe and reproducible by default.
- Make every live integration (sibling Execute-Workflow routing) opt-in, documented, and testable.
- Never forward, echo, or log secret-bearing fields from the caller's request envelope.
- Reject every request that lacks a valid HMAC-SHA256 signature, exceeds the body-size cap, or names a non-allowlisted intent.
- Treat every inbound request as untrusted until the signature is verified.

## Assets

| Asset | Sensitivity | Boundary rule |
| --- | --- | --- |
| `N8N_API_KEY`, n8n credentials | High | Runtime only; never printed or committed. |
| `GATEWAY_SIGNING_SECRET` | High | Runner env only (`n8n-runners` service); never in source, fixtures, snapshots, or logs. Client signs with the same value. |
| `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | Medium | Runner env flag; documents the `require('crypto')` dependency in Code nodes. |
| Webhook URLs | High | Runtime only; examples must use placeholders. |
| Canonical workflow JSON and release snapshots | Medium | Must be scrubbed and secret-scanned before commit. |
| Fixtures and golden test cases | Medium | Must be synthetic; intentional secret-shaped values in test fixtures are allowlisted by path in `Test-RepositorySecrets.ps1`. |
| Audit events and run history | Medium | Store traceable metadata (`traceId`), not raw secrets or unnecessary PII. |

## Trust Boundaries

| Boundary | Current evidence | Required controls |
| --- | --- | --- |
| Git repository <-> local n8n runtime | Repo stores SDK source, scrubbed snapshots, docs, scripts, fixtures. n8n stores credentials and execution history. | Raw exports are intermediate only. Run secret scan/static validation before commit. Do not commit `.env`, credentials, private URLs, or execution data. |
| Caller <-> n8n webhook (gateway entry point) | Gateway exposes `POST /webhook/portfolio/interaction-gateway` with `text/plain` body (the exact signed bytes). Auth is HMAC-SHA256 over `${X-Timestamp}.${rawBody}`; header `X-Signature: sha256=<hex>`; replay window 300 s. | Signature verified timing-safely before any parsing. Missing/bad/expired signature → 401. An unset secret fails closed (not forgeable). A non-finite clock fails closed (no replay bypass). Body-size enforced before routing → 413 if over cap. |
| Gateway <-> sibling workflows (in-process) | Callable siblings are reached via n8n Execute Workflow (in-process, no HTTP, no secret over the wire). The allowlist maps intent names to sibling identifiers; callers never supply a URL (SSRF-closed by construction). | Non-allowlisted intent → 422 before any execution. Secret-strip runs on the full request envelope before forwarding. `traceId` always present in the response. Targets are intent names, never URLs. |
| Gateway <-> secret-stripping | `stripSecrets` is a pure function in `scripts/lib/gateway-core.mjs`; the n8n Code nodes mirror it. `verify:workflow` differentially pins the deployed copy to the core so stripping cannot silently drift. | Secrets are stripped from key names, value strings, and array elements. The `stripped` count is surfaced in the audit event. Entire response envelope is scanned for secret patterns in the self-test. |
| Agent/MCP tooling <-> n8n management API | MCP/API tokens can create, update, execute, publish, or unpublish workflows. | Keep the one-writer rule. Do not expose management credentials to read-only/design agents. Never let agents reveal, rotate, or delete credentials. |

## Interface Design Checklist

Every new or changed interface must answer these before merge:

- What is the entry point: `Webhook`, `Chat Trigger`, `Form Trigger`, `MCP Server Trigger`, bot event, schedule, manual trigger, or script?
- Who is the caller and what authentication or signature verification applies?
- What is the input schema, required fields, maximum payload size, and maximum item count?
- Which fields are PII, secrets, customer data, or sensitive business data?
- What is the idempotency key or replay protection strategy?
- What is the timeout, retry, and rate-limit strategy?
- What is logged, persisted, returned, or sent to external services?
- What is redacted from audit events, generated workflow JSON, fixtures, and screenshots?
- What happens on validation failure, external API failure, and partial downstream failure?
- Which tests or fixtures prove the boundary behavior?

## Privacy Rules

- Collect the minimum data needed to complete the workflow.
- Prefer synthetic fixtures and redacted audit events.
- Do not store raw caller payloads or prompt transcripts unless the workflow contract explicitly requires it.
- Do not send raw payloads to notification channels; send summaries, trace IDs, severity, and operator-safe context.
- Treat logs and eval artifacts as reviewable but not public by default when they contain user text.

## Deployment Assumptions

The repository does not claim production security by itself. A production deployment must still provide:

- TLS termination and secure public routing.
- Rate limits and additional request size limits at the proxy or platform layer.
- Credential rotation and encrypted secret storage for `GATEWAY_SIGNING_SECRET`.
- Environment-specific access controls for n8n, the runner, and sibling workflows.
- Monitoring, alerting, and incident response ownership.

## Required References

- GitHub security policy and private vulnerability reporting: https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository
- n8n environment variable and credential isolation guidance: https://docs.n8n.io/hosting/configuration/environment-variables/
- n8n security overview and node-blocking guidance: https://docs.n8n.io/hosting/securing/overview/
- OWASP API Security Top 10 2023, especially authorization, authentication, resource limits, SSRF, misconfiguration, and unsafe third-party API consumption: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
