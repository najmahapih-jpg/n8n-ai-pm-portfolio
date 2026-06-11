# Security Policy

## Supported Versions

Security fixes apply to the default branch. There are no versioned release artifacts; the adapter
is deployed by running the current branch against your own Feishu app and local gateway.

## Reporting a Vulnerability

Do not post secrets, exploit details, app credentials, or chat data in a public issue.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not
enabled, open a minimal public issue that says a security report is available and ask the
maintainers for a private contact path. Include only non-sensitive impact and affected area
information in the public issue.

## Secrets and Credentials

Never commit:

- `.env` files.
- Feishu app credentials: the `cli_*` app id together with its app secret, tenant access tokens,
  or any verification token.
- `GATEWAY_SIGNING_SECRET` or any HMAC signing key.
- n8n API keys or gateway URLs carrying embedded tokens.
- Chat transcripts, message contents, or user/open ids from real conversations.

Use `.env.example` for variable names and placeholder values only.

## Adapter Security Model

- The adapter holds NO privileged access beyond what any gateway client has: it can only send
  signed requests to an ALLOWLISTED set of gateway intents, and the gateway's own intent allowlist
  remains the final authority (defense in depth).
- Every gateway request is signed with HMAC-SHA256 over the exact bytes `${ts}.${rawBody}`; the
  signing scheme is pinned by an offline known-answer test so contract drift is caught
  byte-for-byte.
- Free text is never routed to an arbitrary target: unknown messages map to the rag
  question intent only.
- Events are deduplicated by `message_id` (Feishu may redeliver), and the adapter replies at most
  once per message.
- The Feishu connection is an OUTBOUND WebSocket (long connection): no public callback URL, no
  inbound port, nothing to expose through a firewall or tunnel.
- Replies are honest by construction: gateway failures and rag abstentions are reported as such;
  the adapter never fabricates an answer the backend did not return.
