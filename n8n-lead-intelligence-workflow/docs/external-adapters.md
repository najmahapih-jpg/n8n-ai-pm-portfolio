# External Adapters

The v0.1 workflow does not require external services. It prepares safe adapter payloads and stops there.

## CRM Adapter

Recommended order:

1. Keep `crmPayload` as the stable contract.
2. Add one HTTP Request node after `Build CRM-ready Payload`.
3. Use idempotent upsert semantics keyed by `crmPayload.externalId` or `crmPayload.idempotencyKey`.
4. Store `CRM_API_URL` and `CRM_API_KEY` outside Git.
5. Add a skipped/dry-run mode before live sends.
6. Add one live adapter smoke case only after the local 11-case suite is green.

## Feishu/Lark Adapter

Use outbound-only custom bot cards if you do not want deployment. Local n8n can call Feishu/Lark directly, so no public callback URL is required.

Recommended order:

1. Keep the current hot-lead notification object as the adapter contract.
2. Add the Feishu HTTP Request node only after `Record Notification Skipped` has been replaced with a runtime config branch.
3. Store `FEISHU_BOT_WEBHOOK_URL` and `FEISHU_BOT_SIGNING_SECRET` outside Git.
4. Keep unsigned or signed webhook card generation in a dedicated Code node.
5. Run all non-Feishu checks first; run a one-case live send last.

Inbound Feishu events, card button callbacks, and bidirectional chat require public reachability or a tunnel. That is intentionally out of scope for this local-first project.
