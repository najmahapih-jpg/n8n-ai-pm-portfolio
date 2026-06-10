# n8n-feishu-adapter

The **inbound Feishu (Lark) bridge** of the n8n Workflow-as-Code portfolio: a small host-side Node
service that receives chat messages over the Feishu **WebSocket long connection** (no public
callback URL, no tunnel — the connection is outbound from your machine), maps each message to an
**allowlisted intent**, **signs** the request with the same HMAC scheme the portfolio's
interaction-gateway verifies, and replies in the chat with the sibling workflow's real result.

```
Feishu group (@bot 提问 / 日报 / 自检)
  → WS long connection → this adapter (pure core: parse → intent → sign)
  → POST signed intent → interaction-gateway (HMAC verify / strip / route)
  → Execute Workflow (in-process) → rag / drift / selftest sibling
  → adapter replies in the chat (answer + citations / drift verdict / ping)
```

The adapter holds **no business logic and no privileged access** — it is just another gateway
client. Unknown text maps to the `rag` question intent, never to an arbitrary target; the
gateway's own intent allowlist stays the final authority.

## Quickstart (offline, zero config)

Prereqs: Node ≥ 20.

```bash
npm ci
npm run verify:core   # 22 assertions: event parsing, mention stripping, intent mapping,
                      # the pinned HMAC signing vector, honest reply building. No network.
```

## Run it live

1. Create a Feishu **self-built app** (开发者后台): enable the **Bot** capability, set
   事件与回调 → 订阅方式 to **使用长连接接收事件**, subscribe to **接收消息
   `im.message.receive_v1`** (approve the permissions the console requests), publish a version,
   and add the bot to your group.
2. `cp .env.example .env` and fill in `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
   `GATEWAY_SIGNING_SECRET` (must equal the gateway's secret in your n8n compose env).
3. Prove connectivity, then run:

```bash
npm run verify:connect   # 15s window: expect "ws client ready", then it exits 0
npm run adapter:start    # long-running; @ the bot in your group
```

Message routing: free text → `rag` (grounded answer with citations, honest abstain);
`日报` / `漂移` / `drift` → `drift` (on-demand health run; the full digest card lands in the
group via the drift monitor's own Feishu notify node); `自检` / `selftest` → `gateway-selftest`.

## Security

- Credentials live only in the gitignored `.env` (`.env.example` documents the keys).
- Every gateway request is HMAC-SHA256 signed over the exact bytes `${ts}.${rawBody}`
  (`X-Signature: sha256=…`), the same contract `verify:core` pins with a known vector.
- Replies never fabricate: a gateway failure, an unexecuted route, and a rag abstention are
  each reported as exactly that.

License: Apache-2.0.
