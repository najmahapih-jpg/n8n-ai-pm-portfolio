# Contributing

This repository is the Feishu inbound adapter for the n8n Workflow-as-Code portfolio: a host-side
Node service that bridges Feishu long-connection events to the local signed interaction-gateway.
Contributions should keep the adapter deterministic to test, honest in its replies, and safe to run
against a local n8n instance.

## Ground Rules

- Keep secrets out of Git. Never commit `.env`, Feishu app credentials (`cli_*` app id + app
  secret), `GATEWAY_SIGNING_SECRET`, gateway URLs with embedded tokens, or chat transcripts.
- Keep ALL business logic in the pure core (`scripts/lib/adapter-core.mjs`). The live shell
  (`src/adapter.mjs`) only wires the core to the Feishu SDK and the gateway; new behavior lands in
  the core first, with offline tests.
- The intent allowlist is fail-closed. Adding an intent requires the matching gateway intent to
  exist; never route free text to an arbitrary target.
- Replies must stay honest: gateway failures, rag abstentions, and degraded retrieval sources are
  reported as such, never papered over. Interactive cards must always carry a plain-text fallback.

## Local Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and fill in your own Feishu app credentials and gateway settings.
   Do not commit `.env`.
4. Start the long connection with `npm run adapter:start` (requires the Feishu console to have
   long-connection event subscription enabled and the bot added to a chat).

## Verification

Run the offline core suite before opening a pull request:

```powershell
npm run verify:core
```

It must pass with zero failures. The suite is fully offline (no Feishu, no gateway, no network):
event parsing, mention stripping, intent mapping, the pinned HMAC signing vector, and reply/card
building for every gateway response family. If you change the signing scheme or the reply shapes,
update the pinned fixtures in `scripts/test-adapter-core.mjs` in the same pull request and explain
why the contract moved.

## Pull Requests

- One focused change per pull request, with the offline suite green.
- Update `README.md` when behavior visible to operators changes (setup steps, intents, reply
  formats).
- Live-path changes (WebSocket handling, Feishu REST calls) should describe how they were verified
  against a real Feishu app, since CI cannot exercise them.
