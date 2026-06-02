# Security and Privacy Boundaries

This document is the required design review surface for interfaces, credentials, AI nodes, external adapters, and data persistence in this n8n Workflow-as-Code project.

It is intentionally conservative: repository artifacts are public-reviewable, while live credentials, private webhook URLs, raw execution history, and customer-like payloads remain local runtime data.

## Security Goals

- Keep the Git repository free of secrets, private webhook URLs, raw live execution data, Authorization headers, cookies, and decrypted n8n credentials.
- Keep stub/offline mode safe and reproducible by default.
- Make every live integration opt-in, documented, and testable.
- Minimize data sent to LLMs, bots, CRM systems, vector stores, and sibling workflows.
- Preserve complete canonical JSON outputs while allowing only validated presentation-layer LLM polishing.
- Treat every inbound request, bot message, form submission, chat message, and third-party template as untrusted input.

## Assets

| Asset | Sensitivity | Boundary rule |
| --- | --- | --- |
| `N8N_API_KEY`, `N8N_MCP_TOKEN`, n8n credentials | High | Runtime only; never printed or committed. |
| Webhook URLs and signing secrets | High | Runtime only; examples must use placeholders. |
| Feishu/Slack/Telegram/CRM credentials | High | Runtime only; outbound payloads must be minimized and redacted. |
| Supabase service-role key | High | Server-side only; never exposed to clients, fixtures, logs, screenshots, or generated workflow JSON. |
| Ollama/OpenAI/Anthropic/Gemini keys or endpoints | High when keyed | Runtime only; LLM prompts must not contain secrets. |
| Canonical workflow JSON and release snapshots | Medium | Must be scrubbed and secret-scanned before commit. |
| Fixtures and golden eval cases | Medium | Must be synthetic or redacted; no production customer data. |
| Audit events and run history | Medium | Store traceable metadata, not raw secrets or unnecessary PII. |

## Trust Boundaries

| Boundary | Current evidence | Required controls |
| --- | --- | --- |
| Git repository <-> local n8n runtime | Repo stores SDK source, scrubbed snapshots, docs, scripts, fixtures. n8n stores credentials and execution history. | Raw exports are intermediate only. Run secret scan/static validation before commit. Do not commit `.env`, credentials, private URLs, or execution data. |
| Caller <-> n8n webhook | Workflows expose webhook APIs and test drivers POST JSON payloads. | Schema/required-field/size validation is DELEGATED to the deployment gateway — the workflow itself only coerces and trims inputs (it does not enforce max string/array sizes). Production exposure needs authentication, rate limits, TLS, request size limits, replay controls, and logging policy outside the workflow. |
| n8n <-> bot/channel adapters | Feishu custom bot support is outbound-only in this suite; future Slack/Telegram/Teams/Email adapters may be added. | Keep webhook URLs/signing secrets in runtime env. Send minimized payloads. Do not send full raw user payloads or secrets. Verify signatures for inbound bot events before routing. |
| n8n <-> CRM or business systems | CRM variables exist as future optional adapters in some `.env.example` files. | Treat as live-only. Use least-privilege API keys, timeouts, idempotency keys, retry limits, and redacted audit events. |
| n8n <-> Ollama or other LLM providers | Several workflows support stub-default and opt-in live LLM calls. | Send only necessary canonical facts. Do not include secrets. Use structured output parsing, guardrails, completeness checks, and deterministic fallback. Track model/source in output. |
| n8n <-> Supabase/vector store | RAG/drift live paths use server-side Supabase service-role credentials. | Service-role key stays runtime-only. RLS should remain enabled with no client policies for server-only tables. Limit RPC/table access and redact logs. |
| n8n <-> sibling workflows | Eval and drift workflows can call sibling webhook SUTs in opt-in connected/live modes. | Keep local/stub default. Use explicit SUT URLs, timeouts, pass/fail thresholds, trace IDs, and no secret propagation across workflow calls. |
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
- What is redacted from audit events, notifications, generated workflow JSON, fixtures, and screenshots?
- What happens on validation failure, LLM failure, external API failure, and partial downstream failure?
- Which tests or fixtures prove the boundary behavior?

## AI and LLM Boundary Rules

- Keep a canonical JSON result as the source of truth.
- Use LLMs for classification, extraction, routing, summarization, or presentation only when the output is schema-validated.
- Final LLM polishing must not add new facts. It must preserve required fields, citations, numbers, decisions, risks, and next steps from canonical JSON.
- Use guardrails or a deterministic validator before sending polished output to a user or external system.
- Fail closed to canonical structured output when polishing or validation fails.
- Do not give AI tools credentials, private webhook URLs, or broad workflow-management authority unless the task explicitly needs it and the session is in a maintenance profile.

## Privacy Rules

- Collect the minimum data needed to complete the workflow.
- Prefer synthetic fixtures and redacted audit events.
- Do not store raw customer messages, emails, account IDs, or prompt transcripts unless the workflow contract explicitly requires it.
- Do not send raw payloads to notification channels; send summaries, trace IDs, severity, and operator-safe context.
- Treat logs and eval artifacts as reviewable but not public by default when they contain user text.
- If persistence is added with Data Table, Supabase, Sheets, Airtable, S3, or a database, define retention, deletion, access, and export rules in the workflow docs.

## Deployment Assumptions

The repository does not claim production security by itself. A production deployment must still provide:

- Public endpoint authentication or signed request verification.
- TLS termination and secure public routing.
- Rate limits and request size limits at the proxy or platform layer.
- Credential rotation and encrypted secret storage.
- Environment-specific access controls for n8n, databases, vector stores, bots, and CRM systems.
- Monitoring, alerting, and incident response ownership.

## Required References

- GitHub security policy and private vulnerability reporting: https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository
- n8n environment variable and credential isolation guidance: https://docs.n8n.io/hosting/configuration/environment-variables/
- n8n security overview and node-blocking guidance: https://docs.n8n.io/hosting/securing/overview/
- OWASP API Security Top 10 2023, especially authorization, authentication, resource limits, SSRF, misconfiguration, and unsafe third-party API consumption: https://owasp.org/API-Security/editions/2023/en/0x11-t10/
