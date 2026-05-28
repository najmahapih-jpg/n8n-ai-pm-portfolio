# Local Feishu Setup

This project supports outbound Feishu group notifications from the local n8n container. It does not require public deployment because n8n calls Feishu directly.

## What Works Locally

- Local n8n sends escalation alerts to a Feishu custom bot webhook.
- Official MCP pin-data tests run without sending real Feishu messages when no webhook is configured.
- Feishu webhook URLs and signing secrets stay outside Git.

## What Needs Public Access

Inbound Feishu event callbacks, card button callbacks, and bidirectional chat require Feishu to reach your n8n webhook. That needs public deployment or a tunnel such as cloudflared, ngrok, or frp. This project does not enable that path.

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
docker compose -f D:\docker\n8n\docker-compose.yml --env-file D:\docker\n8n\.env up -d --force-recreate n8n n8n-runners
```

## Validation

Run the normal no-send regression first:

```powershell
pwsh -NoProfile -File .\scripts\Sync-N8nWorkflowFromSdk.ps1
pwsh -NoProfile -File .\scripts\Test-SupportTriageWorkflow.ps1
pwsh -NoProfile -File .\scripts\Test-FeishuWorkflowJson.ps1
```

Expected result: escalation cases report `feishuDelivery.status=skipped` when no webhook is configured. After a real webhook is configured, those same escalation cases will attempt live sends.

## Operational Notes

- Do not commit real Feishu webhook URLs.
- Do not paste webhook URLs into fixtures or release snapshots.
- If live sends fail, inspect the `feishuDelivery` object in the escalation response and the n8n execution log.
- Keep system time accurate when using signed Feishu bots, because signature verification depends on timestamp freshness.
