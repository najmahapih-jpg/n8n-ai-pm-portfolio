# Local Feishu Notification Design

## Goal

Upgrade `Portfolio - Support Triage API` to `v0.3.0-local-feishu` by adding a local-only Feishu notification path. The workflow continues to run on the user's local n8n instance and sends outbound notifications to a Feishu group custom bot when escalation is required.

## Scope

- Use Feishu custom bot webhook for one-way group notifications.
- Do not expose local n8n to the public internet.
- Do not implement Feishu event callbacks, card interactions, or inbound webhooks from Feishu.
- Do not commit real webhook URLs, signing secrets, or Feishu tokens.
- Preserve the existing deterministic triage, audit, and response behavior.

## Design

The escalation branch will build a Feishu card payload after the escalation audit event. A `Feishu Enabled?` gate checks runtime configuration. If `FEISHU_BOT_WEBHOOK_URL` is missing, the workflow records `feishuDelivery.status=skipped` and continues to return the normal escalation response. If configured, the workflow sends the card through an HTTP Request node.

For signed Feishu custom bots, a Code node generates `timestamp` and `sign` from `FEISHU_BOT_SIGNING_SECRET`. Feishu's documented algorithm uses `timestamp + "\n" + secret` as the HMAC-SHA256 key and signs an empty payload, then Base64 encodes the digest. If no signing secret is configured, the payload omits signature fields.

## Runtime Configuration

- `FEISHU_BOT_WEBHOOK_URL`: required to send real messages.
- `FEISHU_BOT_SIGNING_SECRET`: optional but recommended when the Feishu bot has signature verification enabled.
- `FEISHU_NOTIFY_STANDARD=false`: default behavior keeps standard handling quiet.

## Testing

- Static workflow JSON test verifies the v0.3.0 Feishu nodes exist and no real Feishu secret is committed.
- Existing MCP pin-data regression remains external-call-free by leaving Feishu environment variables unset; escalation cases must execute the skipped notification path.
- Manual live test can be run only after the user sets local Feishu environment variables and explicitly requests a real send.

## Acceptance Criteria

- SDK validates through official n8n MCP.
- Current local draft updates to at least 25 nodes.
- Canonical and `support-triage-v0.3.0.json` release snapshots contain the Feishu branch.
- MCP regression passes for all existing 8 cases without real Feishu configuration.
- Static Feishu integration test passes.
- Secret scan finds no real webhook URL or signing secret.
