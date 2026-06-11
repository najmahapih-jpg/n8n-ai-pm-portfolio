# Adopt the Portfolio on Your Own n8n

Every repo in this portfolio runs its offline gates green from a fresh clone with zero
infrastructure (stub-default). This page covers the **live** adoption path: deploying the
workflows onto **your** n8n instance, where every workflow ID differs from ours and the
cross-workflow wiring must be redone once. Read this before touching any deploy script.

## Dependency graph (deploy in this order)

```
                    ┌─ 1. business siblings (independent of each other) ─┐
                    │  support-triage      (n8n-workflow-as-code)        │
                    │  lead-intelligence   (n8n-lead-intelligence-…)     │
                    │  product-feedback    (n8n-product-feedback-…)      │
                    │  llm-eval-harness    (n8n-llm-eval-harness)        │
                    │  rag-assistant       (n8n-rag-knowledge-assistant) │  ← special case, see below
                    │  drift-monitor       (n8n-scheduled-drift-monitor) │
                    └────────────────────────┬───────────────────────────┘
                                             │ their NEW workflow IDs
                    2. interaction-gateway ──┘  (edit TARGET_WORKFLOW_IDS → recompile → deploy,
                       + gateway-selftest-sibling)
                                             │ signed HMAC calls
                    3. autonomous-agent ─────┘  (tools == gateway intents, no extra wiring)

   n8n-contract-test-runner: no deployment — it contract-checks the other repos from the outside.
```

## Step 0 — runtime prerequisites (once)

n8n ≥ 2.x with the external task runner. Add to the **task-runner environment** (e.g. your
n8n docker compose `.env`):

```text
GATEWAY_SIGNING_SECRET=<generate a long random secret; never commit it>
NODE_FUNCTION_ALLOW_BUILTIN=crypto     # the gateway Code node uses require('crypto')
```

If the runner sits behind a proxy, make sure `NO_PROXY` includes the n8n service name
(the agent's live mode calls the gateway in-process at `http://n8n:5678`). Optional live
backends: local Ollama (reachable from containers at `host.docker.internal:11434`) and a
Supabase project for rag (see that repo's `docs/supabase-setup.md`).

## Step 1 — deploy the business siblings

For each sibling repo: import `workflows/canonical/<name>.canonical.json` via the n8n UI,
or run the repo's `Sync-N8nWorkflowFromSdk.ps1` (needs `N8N_API_URL`/`N8N_API_KEY`, see each
repo's `.env.example`). **Write down the workflow ID n8n assigns to each** — Step 2 needs them.

Two rules learned the hard way:

- **rag is a special case.** Its live deployment carries Supabase credential injection that a
  plain canonical sync will CLOBBER. First deploy from canonical, then follow
  `docs/supabase-setup.md` in that repo to wire credentials; afterwards only use the surgical
  node-level deploy path described there — never re-sync the whole canonical over a live rag.
- **Callable targets must be published.** The gateway reaches siblings via
  `executeWorkflowTrigger`, and n8n only resolves published/active sub-workflows. Activate
  whichever siblings you want routable.

## Step 2 — rewire and deploy the gateway

The intent → workflow-ID map is a hardcoded const in the gateway's SDK source
(`workflows/sdk/interaction-gateway.workflow.js`, `TARGET_WORKFLOW_IDS`):

```js
const TARGET_WORKFLOW_IDS = { 'product-feedback': '<YOUR id>', 'rag': '<YOUR id>', ... };
```

Replace every ID with the ones from Step 1, then:

```bash
npm run compile          # SDK → canonical (the canonical==SDK gate keeps these in lock-step)
npm run verify:static    # must stay green after your edit
# deploy interaction-gateway + gateway-selftest-sibling, then:
npm run verify:live      # signed probe: valid→200 + traceId echo, tampered→401
```

## Step 3 — deploy the agent

Import `workflows/canonical/autonomous-agent.canonical.json`. No ID rewiring needed: the
agent's tool allowlist speaks gateway **intent names**, never workflow IDs. Stub mode works
immediately; live mode (`agentMode=live`) additionally needs Step 0's secret + Ollama.

## Where each variable lives (three distinct layers)

| Layer | Examples | Who reads it |
|---|---|---|
| repo `.env` (host side) | `N8N_API_URL`, `N8N_API_KEY`, `GATEWAY_SIGNING_SECRET`, `OLLAMA_URL` | deploy/verify scripts on your machine (`.env.example` in each repo) |
| n8n runtime env (compose `.env`) | `GATEWAY_SIGNING_SECRET`, `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | Code nodes inside the task runner |
| n8n credentials (UI) | rag's Supabase URL/key | injected into nodes; never in Git, never in env files |

The same `GATEWAY_SIGNING_SECRET` value must exist in the first two layers (signer and verifier).

## Verify the whole system

```bash
# in each repo:            offline gates stay green (no infra needed)
npm run verify:static
# in n8n-contract-test-runner:  cross-repo contract conformance
npm run verify:portfolio
# in n8n-interaction-gateway:   live edge
npm run verify:live
# in n8n-autonomous-agent:      live tools end-to-end (agent → gateway → siblings)
npm run verify:tools
```

If all four levels pass, your instance reproduces the full connected portfolio.
