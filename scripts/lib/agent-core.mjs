// agent-core.mjs — the pure, offline-testable core of the autonomous portfolio agent (Capstone C).
//
// The agent receives an inbound signal (a customer message / ticket / question) and AUTONOMOUSLY decides which
// portfolio tools to invoke — support-triage / product-feedback / rag / eval / drift — in what order, observes
// each result, and produces a consolidated outcome. Its TOOLS are the portfolio workflows, reached in production
// via the signed interaction-gateway (intent-routed, in-process; no secret over HTTP).
//
// Everything here is PURE: the planner (the "brain") and callTool (the tool executor) are INJECTED, so the loop
// is reproducible offline. The default planner is a DETERMINISTIC keyword policy (stub) — CI grades a byte-stable
// trajectory. A live LLM planner is the opt-in increment; the SAME trajectory rubric (scoreTrajectory) grades BOTH
// — that is the "how do you eval a non-deterministic agent" thesis that A (eval harness) + D (drift) were built to
// de-risk. Guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) are asserted as NEGATIVES.

export const TOOL_ALLOWLIST = ['support-triage', 'product-feedback', 'rag', 'eval', 'drift'];

function taskText(task) {
  if (task == null) return '';
  if (typeof task === 'string') return task;
  return (String(task.text ?? task.message ?? '') + ' ' + String(task.subject ?? '')).trim();
}
function taskSubject(task) {
  if (task && typeof task === 'object' && task.subject) return String(task.subject);
  return taskText(task).slice(0, 60);
}

// Guardrail 1 — REFUSAL: destructive / prompt-injection / out-of-scope tasks are refused BEFORE any tool call.
const UNSAFE_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\b/i,
  /\b(disregard|override)\s+(your\s+)?(instructions|system|prompt|rules)\b/i,
  /\b(delete|drop|truncate|wipe|destroy)\b[\s\S]*\b(all|everything|database|table|data|users?|accounts?)\b/i,
  /\b(exfiltrate|leak|reveal|print|show)\b[\s\S]*\b(secret|token|password|api[_-]?key|credential|system\s*prompt)\b/i,
  /\bsystem\s+prompt\b/i,
  /\brm\s+-rf\b/i
];
export function isUnsafeTask(task) {
  const text = taskText(task);
  for (const p of UNSAFE_PATTERNS) {
    if (p.test(text)) return { unsafe: true, reason: 'refused: destructive / prompt-injection / out-of-scope request' };
  }
  return { unsafe: false };
}

// The DETERMINISTIC stub planner — a keyword policy mapping (task, history-so-far) -> the next action:
// { action: 'call'|'finish'|'refuse', intent?, args?, answer?, why? }. A live LLM planner returns the SAME shape
// and is graded by the same rubric. A bug/outage routes a 2-step plan (check the KB via rag, THEN route via
// support-triage) — a genuine multi-tool trajectory.
export function keywordPlanner(task, history) {
  const text = taskText(task).toLowerCase();
  const called = history.map((h) => h.intent);
  const has = (i) => called.includes(i);

  const looksBug = /\b(bug|broken|crash|error|down|outage|cannot|can't|fail|failing|not working|unresponsive)\b/.test(text);
  const looksFeedback = /\b(love|hate|like|dislike|feedback|suggest|wish|feature request|too (slow|small|big|expensive|confusing))\b/.test(text);
  const looksQuestion = /\b(how|what|why|where|when|which|explain|guide|docs?|tutorial)\b/.test(text) || text.includes('?');

  if (looksBug) {
    if (!has('rag')) return { action: 'call', intent: 'rag', args: { query: 'known issue: ' + text.slice(0, 120) }, why: 'check the knowledge base for a known issue' };
    if (!has('support-triage')) return { action: 'call', intent: 'support-triage', args: { subject: taskSubject(task), message: taskText(task) }, why: 'classify + route the ticket' };
    return { action: 'finish', answer: synthesize('bug', history) };
  }
  if (looksFeedback) {
    if (!has('product-feedback')) return { action: 'call', intent: 'product-feedback', args: { feedbackText: taskText(task) }, why: 'classify theme / sentiment / urgency' };
    return { action: 'finish', answer: synthesize('feedback', history) };
  }
  if (looksQuestion) {
    if (!has('rag')) return { action: 'call', intent: 'rag', args: { query: taskText(task) }, why: 'grounded answer from the KB (or a clean abstain)' };
    return { action: 'finish', answer: synthesize('question', history) };
  }
  // No actionable signal -> finish WITHOUT inventing a tool call (no-fabricated-tool discipline).
  if (called.length > 0) return { action: 'finish', answer: synthesize('other', history) };
  return { action: 'finish', answer: 'No actionable signal detected; no tool was appropriate.' };
}

function synthesize(kind, history) {
  const parts = history.filter((h) => h.result && h.result.ok).map((h) => h.intent + ':' + (h.result.summary ?? 'ok'));
  return '[' + kind + '] ' + (parts.length ? parts.join(' | ') : 'no successful tool results');
}

// The PURE agent loop. callTool(intent, args) -> { ok, summary, data } is INJECTED (stub offline / gateway live).
// GUARDRAILS: REFUSAL (unsafe task), NON-ALLOWLISTED-TOOL (never execute an off-allowlist intent), MAX-STEPS
// (bounded loop), NO-FABRICATED-RESULT (the trajectory records only real callTool results; a tool failure is
// recorded as ok:false, never invented). Returns a structured run record (the trajectory) for the eval rubric.
export function runAgentLoop(task, opts = {}) {
  const planner = opts.planner || keywordPlanner;
  const callTool = opts.callTool || (() => ({ ok: false, summary: 'no tool executor injected' }));
  const maxSteps = Number.isFinite(opts.maxSteps) ? opts.maxSteps : 4;
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : TOOL_ALLOWLIST;

  const safe = isUnsafeTask(task);
  if (safe.unsafe) return { refused: true, stopReason: 'refused', reason: safe.reason, trajectory: [], toolCalls: 0, finalAnswer: null, guardrail: 'refusal' };

  const trajectory = [];
  const history = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    let decision;
    try { decision = planner(task, history); } catch (e) {
      return { refused: false, stopReason: 'planner-error', reason: e.message, trajectory, toolCalls: trajectory.length, finalAnswer: null };
    }
    if (!decision || typeof decision !== 'object') return { refused: false, stopReason: 'bad-decision', trajectory, toolCalls: trajectory.length, finalAnswer: null };
    if (decision.action === 'refuse') return { refused: true, stopReason: 'refused', reason: decision.reason || 'planner refused', trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'refusal' };
    if (decision.action === 'finish') return { refused: false, stopReason: 'finished', trajectory, toolCalls: trajectory.length, finalAnswer: decision.answer ?? null };
    if (decision.action === 'call') {
      // GUARDRAIL: never EXECUTE a non-allowlisted intent (a hallucinated / unsafe tool). Stop without calling it.
      if (!allowlist.includes(decision.intent)) {
        return { refused: false, stopReason: 'guardrail:non-allowlisted-tool', blockedIntent: decision.intent, trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'non-allowlisted-tool' };
      }
      let result;
      try { result = callTool(decision.intent, decision.args || {}); } catch (e) { result = { ok: false, summary: 'tool error: ' + e.message }; }
      if (!result || typeof result !== 'object') result = { ok: false, summary: 'tool returned a bad shape' };
      trajectory.push({ step, intent: decision.intent, args: decision.args || {}, ok: result.ok === true, summary: result.summary ?? null });
      history.push({ intent: decision.intent, result });
      continue;
    }
    return { refused: false, stopReason: 'unknown-action', trajectory, toolCalls: trajectory.length, finalAnswer: null };
  }
  // GUARDRAIL: bounded loop — never exceed maxSteps.
  return { refused: false, stopReason: 'guardrail:max-steps', trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'max-steps' };
}

// The agent-trajectory EVAL rubric — grades a run record against a golden expectation. The SAME rubric grades the
// stub planner AND a live LLM planner. Every check is a deterministic boolean (the honest-eval discipline).
export function scoreTrajectory(run, expected) {
  const checks = {};
  const calledSeq = run.trajectory.map((t) => t.intent);
  // (1) tool-call correctness: the SEQUENCE of intents matches the expected trajectory.
  checks.toolSequence = JSON.stringify(calledSeq) === JSON.stringify(expected.tools || []);
  // (2) no invalid tool call ever EXECUTED: every recorded intent is allowlisted.
  checks.allToolsAllowlisted = run.trajectory.every((t) => TOOL_ALLOWLIST.includes(t.intent));
  // (3) tool args present (a real arg derived from the task, not a hallucinated/empty one).
  checks.toolArgsPresent = run.trajectory.every((t) => t.args && Object.keys(t.args).length > 0);
  // (4) outcome / guardrail matches expectation (stopReason + refused).
  checks.outcome = (expected.stopReason ? run.stopReason === expected.stopReason : true)
    && (expected.refused != null ? run.refused === (expected.refused === true) : true);
  // (5) task success: refused-as-expected, or finished with exactly the expected tool sequence.
  checks.taskSuccess = expected.refused ? run.refused === true : (run.stopReason === 'finished' && checks.toolSequence);
  const passed = Object.values(checks).every(Boolean);
  return { passed, checks };
}
