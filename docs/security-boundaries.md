# Security and Privacy Boundaries

This document is the required design review surface for interfaces, file access, external calls, and data handling in this offline contract-test tool.

It is intentionally conservative: the tool's default mode is fully offline and credential-free. Network access is strictly opt-in and scoped to a local webhook target.

## Security Goals

- Keep the Git repository free of secrets, private webhook URLs, raw live execution data, Authorization headers, cookies, and decrypted credentials.
- Keep offline mode safe and reproducible by default with no network calls.
- Make every live integration opt-in, documented, and behind an availability SKIP gate.
- Minimize data read from sibling repos to only the tracked docs and fixture files needed for conformance assertions.
- Never execute or eval content read from target repos.

## Assets

| Asset | Sensitivity | Boundary rule |
| --- | --- | --- |
| `N8N_API_URL`, n8n signing secrets, API keys | High | Runtime only; never printed or committed. Script output must not echo these values. |
| Webhook URLs of live n8n instances | High | Runtime only; examples must use placeholders. |
| Sibling repo fixture files | Low-Medium | Read-only. Must be synthetic or redacted; no production customer data. |
| Self-test fixtures in `fixtures/self/` | Low | Synthetic only. No real credentials or payload data. |

## Trust Boundaries

| Boundary | Current behavior | Required controls |
| --- | --- | --- |
| Git repository <-> local filesystem | Tool reads sibling repos' tracked docs and fixture files by path. | Read only tracked files within the target repo path. Do not follow symlinks outside the target path. Do not execute or eval any content read. |
| Tool <-> local n8n webhook (live mode only) | Opt-in `-Live` flag re-POSTs golden fixture requests to a local webhook and checks response-required fields. | Always check availability first; SKIP honestly (exit 0, labeled) when the target returns 404 or is unreachable. Never send secrets in the request body. Never print response bodies that may contain credentials. |
| Tool <-> CI environment | `npm run verify:self` runs in CI with no credentials and no network access. | CI job must not inject secrets into the offline gate. Live mode must never run in CI without explicit opt-in. |
| Script output <-> terminal/logs | PowerShell writes PASS/FAIL/SKIP lines per assertion to stdout. | Must not print environment variable values, response body snippets that could contain secrets, or file contents beyond brief sanitized excerpts. |

## Interface Design Checklist

Every new or changed interface (new file read, new network call, new environment variable) must answer these before merge:

- What is the entry point: CLI flag, environment variable, or direct script call?
- What file paths or URLs does this access, and are they constrained to expected locations?
- What is printed to stdout/stderr, and is it free of secrets and raw payloads?
- What happens when the target is unavailable, malformed, or returns an error?
- Which self-test fixtures prove the boundary behavior?

## Privacy Rules

- Fixture files must be synthetic or redacted; no production customer data, real email addresses, or real API keys.
- Script output must not reproduce raw fixture content or response bodies that could contain sensitive data.
- If new persistence is added (e.g. result logs), define retention, location, and access rules in the docs.

## Deployment Assumptions

This tool is a local CLI. It does not expose a network interface, hold long-lived credentials, or process untrusted remote input in its default mode. The security boundary is the local filesystem and the optional local n8n instance reached in live mode.

## Required References

- GitHub security policy and private vulnerability reporting: https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository
- n8n environment variable and credential isolation guidance: https://docs.n8n.io/hosting/configuration/environment-variables/
- OWASP API Security Top 10 2023 (relevant for the live-mode POST path): https://owasp.org/API-Security/editions/2023/en/0x11-t10/
