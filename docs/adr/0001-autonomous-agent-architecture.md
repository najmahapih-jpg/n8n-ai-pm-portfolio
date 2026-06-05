# ADR-0001 — An eval-first autonomous agent whose tools are the portfolio (via the signed gateway)

Date: 2026-06-05 · Status: Accepted (design + pure core)

## Context

The portfolio's named capstone is a well-eval'd autonomous agent. Two hard problems: (1) "agents" must be more
than a demo — it needs a real tool-use loop with guardrails; (2) the marquee risk an AI-PM portfolio must answer
is **how to put a non-deterministic LLM agent under a CI gate**. A (eval harness) and D (drift) were built first
specifically to de-risk (2).

## Decision

Build **`n8n-autonomous-agent`**: an agent that, given an inbound signal, runs a **bounded tool-use loop** and
produces a consolidated outcome.

1. **The agent's tools ARE the portfolio workflows**, reached in production via the **signed interaction-gateway**
   (intent-routed, in-process, no secret over HTTP): `support-triage` / `product-feedback` / `rag` / `eval` /
   `drift`. This reuses everything already built and makes C the orchestration capstone over A/B/D + the gateway.
2. **The planner and tool-executor are INJECTED** (`runAgentLoop(task, { planner, callTool, … })`). Offline, a
   **deterministic keyword planner** over **stub tools** yields a byte-stable trajectory; live, an **LLM planner**
   over the **gateway** tools. The SAME `scoreTrajectory` rubric grades both — the non-deterministic-agent eval
   answer.
3. **Guardrails are first-class, asserted as REJECTED NEGATIVES**: refusal (destructive / prompt-injection /
   out-of-scope → no tool), non-allowlisted-tool (a hallucinated tool is never executed), max-steps (bounded
   loop), no-fabricated-result (a tool failure is recorded `ok:false`, never invented).
4. **Stub-default everywhere CI touches** (deterministic planner + stub tools); the live LLM + live gateway are
   opt-in increments.

## Alternatives considered

1. **A free-form LLM agent with no trajectory rubric (rejected).** Ungradeable — exactly the "vibe check" this
   portfolio refuses. The trajectory rubric makes the agent CI-gateable.
2. **A bespoke tool set for the agent (rejected / folded in).** The portfolio already exposes six workflows via
   the gateway; reusing them as tools is lower-maintenance and ties the capstone to A/B/D + the gateway.
3. **Caller-supplied tool URLs (rejected).** The agent names an allowlisted intent, never a URL — tool-closed
   here, SSRF-closed at the gateway. A hallucinated/off-allowlist intent is a guardrail hit, never executed.
4. **Letting the LLM both act and self-grade (rejected).** The trajectory is graded by a deterministic rubric on
   what the agent *did*, not on a model's self-report (the same honesty stance as A's deterministic-first scoring).

## Consequences

**Positive** — a real agentic loop with guardrails; the non-deterministic agent is CI-gateable (stub planner +
trajectory rubric, 39/39); reuses the whole portfolio as tools; the live LLM is held to the same bar (with a
stub-vs-LLM calibration guard, mirroring A's judge-drift guard); low-maintenance (stub-default, no standing infra).

**Negative / trade-offs** — a keyword stub planner is a simplification of real planning (acceptable: it pins the
*rubric* and the *loop/guardrails*; the LLM increment exercises real planning); live tool execution depends on
the gateway + siblings being deployed (they are). Long-horizon planning beyond `maxSteps` is out of scope.

## Adoption sequence

1. ✅ Pure agent core (`scripts/lib/agent-core.mjs`) + the offline trajectory eval (`verify:agent`, 39/39).
2. ✅ The SDK workflow (the n8n agent loop, an `Agent Loop` Code node mirroring the core) + `verify:static` /
   `verify:json` + `verify:workflow` (24/24, a differential asserting the deployed loop == the core) — DEPLOYED +
   live-verified as n8n id `fIAHA00y4Rft2BrC` (bug task → rag→support-triage; unsafe task → refused).
3. Live LLM planner (Ollama) graded by the same rubric + a stub-vs-LLM calibration guard.
4. Live tool execution via the deployed interaction-gateway (sign → route → observe → synthesize).
