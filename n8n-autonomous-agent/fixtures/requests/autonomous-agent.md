# Requirement spec — autonomous-agent (Capstone C)

Status: **design + pure core (2026-06-05)**, authored eval-first (spec → eval-plan → ADR → core → workflow).

## Why this exists

The portfolio's named capstone: a well-eval'd **autonomous agent**. The signal it demonstrates ("agents") is a
named 2026 AI-PM hiring gap. It is also the natural **orchestration layer** over everything already built — its
tools are the six portfolio workflows, reached via the signed interaction-gateway.

## The task contract

Input — an inbound signal:
```jsonc
{ "task": { "subject": "...", "text": "the export button is broken and crashes" } }  // or just a string
```

Output — a **run record** (the trajectory + outcome), the gradeable artifact:
```jsonc
{
  "refused": false,
  "stopReason": "finished",          // finished | refused | guardrail:non-allowlisted-tool | guardrail:max-steps
  "trajectory": [                     // the ordered tool calls + their (real) results
    { "step": 1, "intent": "rag", "args": { "query": "known issue: …" }, "ok": true, "summary": "2 citations" },
    { "step": 2, "intent": "support-triage", "args": { "subject": "…", "message": "…" }, "ok": true, "summary": "routed: platform-support" }
  ],
  "toolCalls": 2,
  "finalAnswer": "[bug] rag:2 citations | support-triage:routed: platform-support",
  "guardrail": null                   // refusal | non-allowlisted-tool | max-steps  (when a guardrail fired)
}
```

## The tools (allowlisted intents — the gateway's routes)

`support-triage` · `product-feedback` · `rag` · `eval` · `drift`. The agent **never** names a tool outside this
allowlist; callers/planners cannot invent one (SSRF-closed at the gateway by construction, tool-closed here).

## The pure core (offline-assertable)

The security + control logic is pure functions (`scripts/lib/agent-core.mjs`), asserted **in-process without a
running n8n or LLM**:

- `runAgentLoop(task, { planner, callTool, maxSteps, allowlist })` — the bounded tool-use loop. `planner` and
  `callTool` are INJECTED (stub offline, LLM+gateway live).
- `keywordPlanner(task, history)` — the deterministic stub policy (a live LLM planner returns the same shape).
- `isUnsafeTask(task)` — the refusal guardrail.
- `scoreTrajectory(run, expected)` — the trajectory eval rubric (the SAME rubric grades stub + LLM).

## Hard acceptance criteria (asserted as negatives — see docs/eval-plan.md)

1. **tool-call correctness** — for a golden task, the executed intent SEQUENCE equals the expected trajectory.
2. **refusal** — a destructive / prompt-injection task → `refused`, zero tool calls.
3. **non-allowlisted-tool** — a planner emitting an off-allowlist intent → it is NEVER executed (guardrail).
4. **max-steps** — a non-terminating planner → the loop stops at `maxSteps` (bounded).
5. **no-fabricated-result** — a failing tool is recorded `ok:false`; the agent never invents a tool result.

## Stub-default

CI touches only the STUB path: deterministic planner + deterministic stub tools → a byte-stable trajectory.
Live mode (opt-in) swaps in a real LLM planner and live gateway tools — graded by the same rubric.

## Out of scope (v0.1.0)

- The SDK workflow (the n8n agent loop) — next increment.
- The live LLM planner + live gateway tool execution — opt-in increments.
- Multi-turn memory / long-horizon planning beyond `maxSteps`.
