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
- Feishu, Slack, Telegram, Discord, email, or CRM credentials.
- Supabase, database, vector-store, or storage keys.
- Raw production payloads or customer data.

Use `.env.example` for variable names and placeholder values only.

## Workflow Security Expectations

- The gateway webhook validates HMAC-SHA256 signatures and rejects missing, tampered, or expired requests (401).
- Oversized bodies are rejected before any processing (413).
- Non-allowlisted intents are rejected; callers never supply URLs (SSRF-closed by construction) (422).
- Secret-bearing fields are stripped from the entire request envelope before any forwarding, echo, or logging.
- Live-mode integrations (sibling Execute-Workflow routing) must be opt-in and documented.
- Generated workflow snapshots must be scrubbed before commit.
- Interface, security-function, external-adapter, and generated-artifact changes must be reviewed against `docs/security-boundaries.md`.

## Known Non-Goals

This repository is not a hosted security boundary by itself. Production deployments still need environment-specific controls such as TLS termination, rate limiting, credential rotation, encrypted secret storage, and network restrictions.
