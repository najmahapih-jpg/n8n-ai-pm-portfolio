# Security and Privacy Boundaries

This document is the required design review surface for interfaces, credentials, AI nodes, external adapters, and data persistence in this n8n Workflow-as-Code project.

It is intentionally conservative: repository artifacts are public-reviewable, while live credentials, private webhook URLs, raw execution history, and customer-like payloads remain local runtime data.

## Security Goals

- Keep the Git repository free of secrets, private webhook URLs, raw live execution data, Authorization headers, cookies, and decrypted n8n credentials.
- Keep stub/offline mode safe and reproducible by default.
- Make every live integration opt-in, documented, and testable.
- Ensure all agent tool calls are signed (HMAC-SHA256) and routed only through the allowlisted intent map; callers cannot supply a raw URL.
- Preserve guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) in every workflow and agent-core change.
- Treat every inbound task, bot message, form submission, and third-party payload as untrusted input.

## Assets

| Asset | Sensitivity | Boundary rule |
| --- | --- | --- |
| `N8N_API_KEY`, n8n credentials | High | Runtime only; never printed or committed. |
| `GATEWAY_SIGNING_SECRET` | High | Runtime only (runner env); never printed, logged, or committed. The agent signs each gateway call with HMAC-SHA256 over the exact request bytes. |
| Webhook URLs | High | Runtime only; examples must use placeholders. |
| Ollama/LLM endpoints | Medium when local | Runtime only; LLM prompts must not contain secrets. |
| Canonical workflow JSON and release snapshots | Medium | Must be scrubbed and secret-scanned before commit. |
| Fixtures and golden trajectory cases | Medium | Must be synthetic or redacted; no production customer data. |
| Audit events and run history | Medium | Store traceable metadata (stopReason, tool sequence, counts); never the raw task text or customer data. |

## Trust Boundaries

| Boundary | Current evidence | Required controls |
| --- | --- | --- |
| Git repository <-> local n8n runtime | Repo stores SDK source, scrubbed snapshots, docs, scripts, fixtures. n8n stores credentials and execution history. | Raw exports are intermediate only. Run secret scan/static validation before commit. Do not commit `.env`, credentials, private URLs, or execution data. |
| Caller <-> n8n webhook | The workflow exposes `POST /webhook/portfolio/autonomous-agent`. `task.text` is untrusted input; refusal guardrail fires before any tool call on unsafe patterns. `maxSteps` is env-only — a caller cannot widen the bound. | Schema/required-field/size validation is delegated to the deployment gateway. Production exposure needs authentication, rate limits, TLS, request size limits, replay controls, and logging policy outside the workflow. |
| Agent loop <-> interaction-gateway | The agent names an allowlisted **intent** (never a raw URL). Each call is HMAC-SHA256 signed over the exact request bytes (`ts.rawBody`) with `GATEWAY_SIGNING_SECRET`. The gateway verifies the signature and routes to the real portfolio sibling in-process. | Non-allowlisted intents are blocked before the gateway is called (guardrail:non-allowlisted-tool). The signing secret stays in the runner env; it is never printed or returned in the response. |
| n8n agent loop <-> portfolio siblings | The six portfolio workflows (support-triage / product-feedback / rag / eval / drift) are reached in-process via the signed gateway, not by direct HTTP. | The agent passes only the minimum args each sibling needs (e.g. `customerEmail` for support-triage). Tool failures are recorded as `ok:false`; the agent never fabricates a successful result. |
| n8n <-> Ollama (opt-in live path) | `agentMode=live` calls Ollama (`host.docker.internal:11434`) to classify the task. | The LLM only classifies (returns a label); the deterministic `routeByClass` function owns multi-step routing. Prompts must not contain secrets. Ollama is unreachable in stub/CI mode — the opt-in path skips cleanly. |
| Agent/MCP tooling <-> n8n management API | Deployment uses the n8n public REST API (`N8N_API_KEY`). | Keep the one-writer rule. Do not expose management credentials to read-only/design agents. Never let agents reveal, rotate, or delete credentials. |

## Interface Design Checklist

Every new or changed interface must answer these before merge:

- What is the entry point: `Webhook`, `Chat Trigger`, `Form Trigger`, `MCP Server Trigger`, bot event, schedule, manual trigger, or script?
- Who is the caller and what authentication or signature verification applies?
- What is the input schema, required fields, maximum payload size, and maximum item count?
- Which fields are PII, secrets, customer data, or sensitive business data?
- What is the idempotency key or replay protection strategy?
- What is the timeout, retry, and rate-limit strategy?
- What is logged, persisted, returned, or sent to external services?
- What is redacted from audit events, notifications, generated workflow JSON, fixtures, and screenshots?
- What happens on validation failure, LLM failure, external API failure, and partial downstream failure?
- Which tests or fixtures prove the boundary behavior?

## AI and LLM Boundary Rules

- The LLM (Ollama, opt-in) is used only for task classification; it names a label, not a tool URL.
- The deterministic `routeByClass` function owns multi-step tool routing — the LLM cannot override it.
- Guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) apply regardless of whether the planner is stub or LLM.
- LLM prompts must not contain secrets, signing keys, or raw customer PII beyond the minimum task text needed for classification.
- A malformed or unexpected LLM reply degrades to a safe finish with zero tool calls; it never fabricates a result.
- Do not give AI tools credentials, private webhook URLs, or broad workflow-management authority unless the task explicitly needs it and the session is in a maintenance profile.

## Privacy Rules

- Collect the minimum data needed to complete the workflow.
- Prefer synthetic fixtures and redacted audit events.
- Do not store raw customer messages, emails, account IDs, or prompt transcripts unless the workflow contract explicitly requires it.
- Audit events record only `stopReason`, tool sequence, and counts — not the raw task text or customer email.
- Treat logs and eval artifacts as reviewable but not public by default when they contain user text.
- If persistence is added (Data Table, Supabase, Sheets, Airtable, S3, or a database), define retention, deletion, access, and export rules in the workflow docs.

## Deployment Assumptions

The repository does not claim production security by itself. A production deployment must still provide:

- Public endpoint authentication or signed request verification.
- TLS termination and secure public routing.
- Rate limits and request size limits at the proxy or platform layer.
- Credential rotation and encrypted secret storage.
- Environment-specific access controls for n8n, Ollama, the interaction-gateway, and any downstream portfolio siblings.
- Monitoring, alerting, and incident response ownership.

## Required References

- GitHub security policy and private vulnerability reporting: https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository
- n8n environment variable and credential isolation guidance: https://docs.n8n.io/hosting/configuration/environment-variables/
- n8n security overview and node-blocking guidance: https://docs.n8n.io/hosting/securing/overview/
- OWASP API Security Top 10 2023, especially authorization, authentication, resource limits, SSRF, misconfiguration, and unsafe third-party API consumption: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
