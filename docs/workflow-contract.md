# Workflow Contract

## Workflow

- Name: `Portfolio - Autonomous Agent`
- Version: `0.1.0`
- Primary entry point: `POST /webhook/portfolio/autonomous-agent`
- Editor entry point: manual trigger demo (built-in bug task)
- Default mode: deterministic stub planner + stub tools (byte-stable, differential-pinned)
- Source of truth: `workflows/sdk/autonomous-agent.workflow.js`
- Release snapshot: `workflows/releases/autonomous-agent-v0.1.0.json`

## Purpose

Given an inbound signal (a ticket, feedback item, or question), run a **bounded tool-use loop**: plan → pick an allowlisted tool (intent) → call it via the signed interaction-gateway → observe → decide (done? next tool? refuse?) → synthesize a consolidated outcome. The agent's tools are the other portfolio workflows (`support-triage`, `product-feedback`, `rag`, `eval`, `drift`), reached in-process via the gateway. A deterministic trajectory rubric (`scoreTrajectory`) grades the stub planner and an opt-in live LLM planner with the same checks.

## Input Contract

Accepted content type: JSON.

Request body:

```json
{
  "task": {
    "subject": "Export broken",
    "text": "the export button is broken and crashes on mobile",
    "customerEmail": "user@example.com"
  },
  "agentMode": "stub"
}
```

Fields:

- `task` (required): the inbound signal. Accepted as `{ subject, text, customerEmail? }` or as a plain string.
  - `task.subject`: short summary of the task.
  - `task.text`: full task description. **Untrusted input** — the refusal guardrail fires before any tool call on unsafe patterns (destructive commands, prompt-injection attempts, out-of-scope requests).
  - `task.customerEmail`: optional caller-supplied email; forwarded to `support-triage` when the bug route runs.
- `agentMode` (optional): `"stub"` (default) or `"live"`. The `live` mode runs a real LLM classifier (Ollama) and signs + drives the gateway tools in-process. The stub mode runs the deterministic keyword planner over stub tools and is byte-stable and differential-pinned.
- `traceId` (optional): caller-supplied correlation id. When present, it is echoed unchanged on the response body and audit event, and forwarded (signed into the HMAC-covered request body) to the interaction-gateway on every tool call so the gateway/sibling can capture it. When absent, `requestId` is used as a fallback; when both are absent, `traceId` is `null`. The agent **never generates** a traceId — it only echoes what the caller supplies. A gateway-response traceId (returned by the gateway after routing a tool call) is recorded on the corresponding trajectory step for cross-run correlation. `traceId` feeds no id/hash seed and is not scored by `scoreTrajectory`.

**`maxSteps` is NOT a request field.** It is read from the `AGENT_MAX_STEPS` environment variable only. A caller cannot widen the bound.

## Operational Limits

- NOTE: the size/string/item limits in this section are **not enforced in-workflow** (the workflow only coerces and trims inputs); they are the caps a deployment gateway should enforce in front of the public webhook.
- Default `maxSteps`: 4 (overridable only via `AGENT_MAX_STEPS` env; not exposed to callers).
- Tool allowlist: `support-triage`, `product-feedback`, `rag`, `eval`, `drift`. A non-allowlisted intent is blocked before the gateway is called.
- Idempotency: the workflow is stateless and does not deduplicate runs.
- Timeout per gateway tool call: governed by the interaction-gateway's per-target timeout.
- Retry behavior: no automatic retry is part of the public contract. A tool failure is recorded as `ok:false` in the trajectory; the agent loop continues to the next step.
- Rate limiting is not implemented inside the workflow. Public deployment must enforce authentication, request size, rate limits, and replay controls at the gateway/platform layer.

## Output Contract

Successful responses return HTTP 200. **Unsafe or refused tasks also return HTTP 200** with `refused: true` — there is no 4xx refusal contract.

```json
{
  "ok": true,
  "refused": false,
  "stopReason": "finished",
  "trajectory": [
    { "step": 1, "intent": "rag", "args": { "query": "known issue: ..." }, "ok": true, "summary": "2 citations (known-issue check)" },
    { "step": 2, "intent": "support-triage", "args": { "customerEmail": "user@example.com", "subject": "Export broken", "message": "..." }, "ok": true, "summary": "routed: platform-support, urgency: high" }
  ],
  "toolCalls": 2,
  "finalAnswer": "[bug] rag:2 citations (known-issue check) | support-triage:routed: platform-support, urgency: high",
  "guardrail": null,
  "plannerSource": "stub",
  "toolSource": "stub",
  "policyVersion": "autonomous-agent-v0.1.0"
}
```

Refused task example:

```json
{
  "ok": false,
  "refused": true,
  "stopReason": "refused",
  "trajectory": [],
  "toolCalls": 0,
  "finalAnswer": null,
  "guardrail": "refusal",
  "plannerSource": "stub",
  "toolSource": "stub",
  "policyVersion": "autonomous-agent-v0.1.0"
}
```

Response fields:

- `ok`: `true` when the agent finished without refusal; `false` when refused or a guardrail fired.
- `refused`: `true` when the refusal guardrail fired (unsafe / destructive / prompt-injection / out-of-scope task).
- `stopReason`: `"finished"` | `"refused"` | `"guardrail:max-steps"` | `"guardrail:non-allowlisted-tool"` | `"planner-error"` | `"bad-decision"` | `"unknown-action"` | `"live-unavailable"`.
- `trajectory`: array of `{ step, intent, args, ok, summary[, traceId] }` — the executed tool calls. The optional `traceId` field on each step carries the gateway/sibling correlation id returned by that tool call; absent on steps where the gateway returned none. Intentionally omits raw task text and customer data.
- `toolCalls`: count of tool calls in the trajectory.
- `finalAnswer`: synthesized answer string, or `null` when refused.
- `guardrail`: the guardrail that fired (`"refusal"` | `"non-allowlisted-tool"` | `"max-steps"` | `null`).
- `plannerSource`: `"stub"` or `"llm:<model>"` (e.g. `"llm:llama3.2:3b"`).
- `toolSource`: `"stub"` or `"gateway"`.
- `traceId`: echoed from the request `traceId` (or `requestId` fallback); `null` when neither was supplied by the caller.
- `policyVersion`: always `"autonomous-agent-v0.1.0"`.

## External Integrations

- `agentMode:"stub"` (default): deterministic keyword planner + stub tools. No external calls.
- `agentMode:"live"`: the Agent Loop Code node classifies the task via Ollama (`host.docker.internal:11434`, model `llama3.2:3b`), then calls the interaction-gateway (`http://n8n:5678/webhook/portfolio/interaction-gateway`) in-process, signing each request with HMAC-SHA256 over the request bytes using `GATEWAY_SIGNING_SECRET`. Requires `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and `GATEWAY_SIGNING_SECRET` in the n8n external task-runner env.
- The gateway routes each signed intent to one of the six portfolio siblings in-process.

## Security and Privacy Boundary

- Task text is untrusted input; the refusal guardrail screens it before any tool call.
- Tool calls are signed and intent-routed; callers cannot supply a raw URL.
- `maxSteps` is env-only; callers cannot widen the loop bound.
- Audit events record only `stopReason`, tool sequence, and counts — not raw task text or customer email.
- See `docs/security-boundaries.md` for full interface rules.

## Contract Tests

Primary fixtures:

- `fixtures/golden/01-bug-known-issue.json`
- `fixtures/golden/02-question-grounded.json`
- `fixtures/golden/03-feedback.json`
- `fixtures/golden/04-unsafe-injection.json`
- `fixtures/golden/05-unsafe-destructive.json`
- `fixtures/golden/06-no-signal.json`

Required offline gates:

```powershell
npm run verify:static
npm run verify:json
npm run verify:agent
npm run verify:workflow
npm run verify:gateway-client
```

Live gates are opt-in: `verify:llm` (real LLM planner via Ollama) and `verify:tools` (real gateway tool execution).

## Machine-readable contract

Parsed by `n8n-contract-test-runner` (`Test-Contract.ps1`). `request.limits` are **gateway-delegated**.

```json
{
  "contractVersion": "autonomous-agent-v0.1.0",
  "webhookPath": "webhook/portfolio/autonomous-agent",
  "request": {
    "accepted": ["task", "agentMode", "traceId"],
    "required": ["task"],
    "notes": "maxSteps is env-only (AGENT_MAX_STEPS); it is NOT a request field and callers cannot widen the bound.",
    "limits": { "bodyBytes": 65536 },
    "limitsEnforcedBy": "gateway"
  },
  "response": {
    "required": ["ok", "refused", "stopReason", "trajectory", "toolCalls", "finalAnswer", "guardrail", "plannerSource", "toolSource", "traceId", "policyVersion"],
    "types": { "ok": "boolean", "refused": "boolean", "toolCalls": "number", "traceId": "string|null" },
    "notes": "Unsafe/refused tasks return HTTP 200 with refused:true. There is no 4xx refusal contract."
  },
  "errors": [],
  "fixtures": {
    "dir": "fixtures/golden",
    "ignoreKeys": ["id", "description", "expect"],
    "valid": [
      "01-bug-known-issue.json",
      "02-question-grounded.json",
      "03-feedback.json",
      "04-unsafe-injection.json",
      "05-unsafe-destructive.json",
      "06-no-signal.json",
      "07-traceid-correlation.json"
    ],
    "errorCases": []
  }
}
```
