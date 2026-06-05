// agent-loop-async.mjs — the ASYNC twin of runAgentLoop (agent-core), for the LIVE tiers only. Identical guardrails
// (refusal pre-check / non-allowlisted-tool / max-steps / no-fabricated-result), but it AWAITS an async planner
// (a live LLM) AND an async callTool (the signed gateway). The SYNC runAgentLoop in agent-core is the source of
// truth — it drives the deployed n8n workflow and is differential-pinned by verify:workflow; this exists only
// because real LLM + real HTTP tools are async. Keep the two in lockstep (same shape, same guardrails).
import { TOOL_ALLOWLIST, isUnsafeTask } from './agent-core.mjs';

export async function runAgentLoopAsync(task, opts = {}) {
  const planner = opts.planner;
  const callTool = opts.callTool;
  const maxSteps = Number.isFinite(opts.maxSteps) ? opts.maxSteps : 4;
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : TOOL_ALLOWLIST;

  const safe = isUnsafeTask(task);
  if (safe.unsafe) return { refused: true, stopReason: 'refused', reason: safe.reason, trajectory: [], toolCalls: 0, finalAnswer: null, guardrail: 'refusal' };

  const trajectory = [];
  const history = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    let decision;
    try { decision = await planner(task, history); } catch (e) { decision = { action: 'finish', answer: 'planner error: ' + (e && e.message ? e.message : 'failed') }; }
    if (decision.action === 'refuse') return { refused: true, stopReason: 'refused', reason: decision.why, trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'refusal' };
    if (decision.action === 'finish') return { refused: false, stopReason: 'finished', trajectory, toolCalls: trajectory.length, finalAnswer: decision.answer == null ? null : decision.answer };
    if (decision.action === 'call') {
      if (!allowlist.includes(decision.intent)) return { refused: false, stopReason: 'guardrail:non-allowlisted-tool', blockedIntent: decision.intent, trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'non-allowlisted-tool' };
      let result;
      try { result = await callTool(decision.intent, decision.args || {}); } catch (e) { result = { ok: false, summary: 'callTool threw: ' + (e && e.message ? e.message : 'error') }; }
      trajectory.push({ step, intent: decision.intent, args: decision.args || {}, ok: result.ok === true, summary: result.summary == null ? null : result.summary });
      history.push({ intent: decision.intent, result });
      continue;
    }
    return { refused: false, stopReason: 'unknown-action', trajectory, toolCalls: trajectory.length, finalAnswer: null };
  }
  return { refused: false, stopReason: 'guardrail:max-steps', trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'max-steps' };
}
