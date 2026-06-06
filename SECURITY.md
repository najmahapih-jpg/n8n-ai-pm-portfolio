# Security Policy

## Supported Versions

Security fixes apply to the default branch and the latest tagged release. Older commits are reference artifacts and may not receive fixes unless the issue also affects the current tool.

## Reporting a Vulnerability

Do not post secrets, exploit details, private webhook URLs, or live customer data in a public issue.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not enabled, open a minimal public issue that says a security report is available and ask the maintainers for a private contact path. Include only non-sensitive impact and affected area information in the public issue.

## Secrets and Credentials

Never commit:

- `.env` files.
- n8n API keys.
- Webhook URLs or signing secrets.
- Any token or credential used to reach a live n8n instance.
- Raw production payloads or customer data.

Use `.env.example` for variable names and placeholder values only.

## Tool Security Expectations

- Offline mode (the default) makes no network calls and holds no credentials.
- Live mode (`-Live`) re-POSTs golden requests to a local webhook only, and degrades gracefully (SKIP, exit 0) when the target is unavailable.
- Fixtures must be synthetic or redacted; no production customer data.
- The tool reads other repos' tracked docs and fixture files; it must not follow symlinks outside the target repo or execute any content it reads.
- Script output must not print secrets, tokens, or private URLs even when they are present in the environment.

## Known Non-Goals

This repository is an offline CLI tool, not a hosted service. It does not expose a webhook, hold credentials, or process untrusted remote input in its default mode. Production deployments of the sibling n8n workflows still need their own environment-specific controls.
