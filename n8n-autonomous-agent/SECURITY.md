# Security Policy

## Supported Versions

Security fixes apply to the default branch and the latest tagged or documented release snapshot. Older snapshots are reference artifacts and may not receive fixes unless the issue also affects the current workflow.

## Reporting a Vulnerability

Do not post secrets, exploit details, private webhook URLs, or live customer data in a public issue.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, open a minimal public issue that says a security report is available and ask the maintainers for a private contact path. Include only non-sensitive impact and affected area information in the public issue.

## Secrets and Credentials

Never commit:

- `.env` files.
- n8n API keys.
- Webhook URLs or signing secrets (including `GATEWAY_SIGNING_SECRET`).
- Ollama or other LLM endpoints that carry auth tokens.
- Raw production payloads or customer data.

Use `.env.example` for variable names and placeholder values only.

## Workflow Security Expectations

- Public webhooks should validate required fields and reject malformed payloads.
- Live-mode integrations (`agentMode=live`) must be opt-in and documented.
- Generated workflow snapshots must be scrubbed before commit.
- Agent tool calls must be signed (HMAC) and routed only to allowlisted intents via the interaction-gateway; callers cannot name a URL directly.
- Guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) must be preserved in any workflow or agent-core change.
- External notifications should avoid leaking secrets, raw credentials, or full sensitive payloads.
- Audit events should be redacted and traceable with non-secret IDs.
- Interface, credential, AI-node, persistence, and external-adapter changes must be reviewed against `docs/security-boundaries.md`.

## Known Non-Goals

This repository is not a hosted security boundary by itself. Production deployments still need environment-specific controls such as authentication, network restrictions, rate limiting, credential rotation, encrypted secret storage, and tenant isolation.
