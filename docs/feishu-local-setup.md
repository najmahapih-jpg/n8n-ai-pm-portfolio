# Local Feishu Setup

This project supports outbound Feishu group notifications from the local n8n container. It does not require public deployment because n8n calls Feishu directly.

## What Works Locally

- Local n8n sends escalation alerts to a Feishu custom bot webhook.
- Official MCP pin-data tests run without sending real Feishu messages when no webhook is configured.
- Feishu webhook URLs and signing secrets stay outside Git.

## What Needs Public Access

Inbound Feishu event callbacks, card button callbacks, and bidirectional chat require Feishu to reach your n8n webhook. That needs public deployment or a tunnel such as cloudflared, ngrok, or frp. This project does not enable that path.

## Best No-Deployment Options

1. Outbound-only custom bot alerts. This is the recommended path for this portfolio project. Keep n8n local, send escalation cards to Feishu with HTTP Request, and validate the whole workflow through pin-data tests. No public URL is required because the network call starts from your machine.
2. Manual live-send validation. Put a real custom bot webhook in your local Docker environment, run one escalation fixture, verify the message appears in a private test group, then remove or rotate the webhook if needed. This proves real integration without deploying the n8n instance.
3. Temporary tunnel only for callbacks. If you later need slash commands, bot mentions, card buttons, or event subscriptions, use a short-lived cloudflared/ngrok/frp tunnel while testing. Treat that as callback validation, not as production deployment.

For now, avoid path 3 unless the project requirement changes. The current workflow is intentionally one-way because it is simpler, safer, and enough to demonstrate a real business integration.

## Feishu Bot Configuration

1. Open the target Feishu group.
2. Add a custom bot.
3. Copy the webhook URL.
4. Enable signature verification if required by your workspace security policy.
5. Keep both values private.

Feishu's custom bot documentation describes the signature as HMAC-SHA256 over an empty payload using `timestamp + "\n" + secret` as the key, then Base64 encoding the digest. The workflow implements that algorithm when `FEISHU_BOT_SIGNING_SECRET` is set.

## Local n8n Configuration

Add these to your local Docker environment file, not to this repository:

```text
FEISHU_BOT_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/<your-hook-id>
FEISHU_BOT_SIGNING_SECRET=<optional-signing-secret>
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Ensure `docker-compose.yml` passes the variables into the `n8n` service:

```yaml
- FEISHU_BOT_WEBHOOK_URL=${FEISHU_BOT_WEBHOOK_URL}
- FEISHU_BOT_SIGNING_SECRET=${FEISHU_BOT_SIGNING_SECRET}
- N8N_BLOCK_ENV_ACCESS_IN_NODE=${N8N_BLOCK_ENV_ACCESS_IN_NODE}
```

Keep dangerous local nodes excluded:

```text
NODES_EXCLUDE=["n8n-nodes-base.executeCommand","n8n-nodes-base.readWriteFile"]
```

Restart n8n after changing the environment:

```powershell
docker compose -f <your-n8n-docker-dir>\docker-compose.yml --env-file <your-n8n-docker-dir>\.env up -d --force-recreate n8n n8n-runners
```

## Validation

Run the normal no-send regression first:

```powershell
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1
pwsh -NoProfile -File .\scripts\Test-FeishuWorkflowJson.ps1
```

Expected result: escalation cases report `feishuDelivery.status=skipped` when no webhook is configured. After a real webhook is configured, those same escalation cases will attempt live sends.

For a no-deployment live-send smoke test:

1. Create a private Feishu test group and add a custom bot.
2. Add only the webhook and optional signing secret to your local Docker environment.
3. Recreate the local n8n containers.
4. Run one escalation case with the explicit send assertion:

```powershell
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1 -CaseName enterprise-incident -FeishuMode sent
```

5. Confirm one Feishu card appears in the private test group.

## Operational Notes

- Do not commit real Feishu webhook URLs.
- Do not paste webhook URLs into fixtures or release snapshots.
- If live sends fail, inspect the `feishuDelivery` object in the escalation response and the n8n execution log.
- Keep system time accurate when using signed Feishu bots, because signature verification depends on timestamp freshness.
