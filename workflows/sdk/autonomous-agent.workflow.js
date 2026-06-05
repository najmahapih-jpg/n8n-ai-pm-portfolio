import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

// Autonomous Agent v0.1.0 (Capstone C) — the n8n agent loop wrapping scripts/lib/agent-core.mjs.
//
// Given an inbound signal, the agent runs a BOUNDED tool-use loop: plan -> pick an allowlisted tool (intent) ->
// call it -> observe -> decide (done? next? refuse?) -> ... -> synthesize. Its tools ARE the portfolio workflows,
// reached via the signed interaction-gateway. The agent-core is the single source of truth (verify:agent 39/39);
// the Agent Loop Code node MIRRORS it inline (n8n Code nodes can't import the .mjs), and scripts/test-agent-workflow.mjs
// extracts the COMPILED Agent Loop body, runs the golden tasks through it, AND differentially checks it vs the core
// — so the deployed copy can't silently drift. STUB-DEFAULT: v0.1.0 runs the deterministic keyword planner over
// STUB tools (byte-stable trajectory). A live LLM planner + live gateway tool execution are the opt-in next
// increments. Guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) are proven negatives.

const POLICY_VERSION = 'autonomous-agent-v0.1.0';

const receiveTask = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Task (POST)',
    position: [180, 320],
    parameters: { httpMethod: 'POST', path: 'portfolio/autonomous-agent', authentication: 'none', responseMode: 'responseNode', options: { rawBody: true, allowedOrigins: '*' } }
  }
});

const runFromUi = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Demo From n8n UI', position: [180, 600] } });

const buildDemoTask = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Demo Task',
    position: [420, 600],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `return [{ json: { __demo: true, body: { task: { subject: 'Export broken', text: 'the export button is broken and crashes on mobile' } } } }];` }
  }
});

const normalizeTask = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Task',
    position: [660, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Parse the inbound signal into a normalized task. Accepts { task: {subject,text} } or { task: "string" } or
// the raw fields. maxSteps comes from env ONLY (a caller can't widen the bound). The task TEXT is untrusted input.
const src = items[0].json || {};
function envGet(name){ try { return (typeof $env !== 'undefined' && $env) ? $env[name] : undefined; } catch (e) { return undefined; } }
const isDemo = src.__demo === true;
const entrypoint = isDemo ? 'manual' : 'webhook';
let body;
if (typeof src.rawBody === 'string') { try { body = JSON.parse(src.rawBody); } catch (e) { body = {}; } }
else if (typeof src.body === 'string') { try { body = JSON.parse(src.body); } catch (e) { body = { task: src.body }; } }
else { body = (src.body && typeof src.body === 'object') ? src.body : src; }
let task = body.task != null ? body.task : body;
if (typeof task === 'string') task = { text: task };
if (!task || typeof task !== 'object') task = {};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const maxSteps = num(envGet('AGENT_MAX_STEPS'), 4);
return [{ json: { task: { subject: String(task.subject || ''), text: String(task.text || task.message || '') }, config: { maxSteps: maxSteps }, entrypoint: entrypoint, policyVersion: '${POLICY_VERSION}' } }];`
    }
  }
});

const agentLoop = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Agent Loop',
    position: [900, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// MIRRORS scripts/lib/agent-core.mjs (the audited source of truth, verify:agent 39/39). The bounded tool-use
// loop + deterministic keyword planner + refusal/allowlist/max-steps/no-fabricated guardrails. STUB tools here;
// live gateway tool execution is the opt-in next increment.
const TOOL_ALLOWLIST = ['support-triage', 'product-feedback', 'rag', 'eval', 'drift'];
function taskText(task) { if (task == null) return ''; if (typeof task === 'string') return task; return (String(task.text == null ? '' : task.text) + ' ' + String(task.subject == null ? '' : task.subject)).trim(); }
function taskSubject(task) { if (task && typeof task === 'object' && task.subject) return String(task.subject); return taskText(task).slice(0, 60); }
const UNSAFE_PATTERNS = [
  /\\bignore\\s+(all\\s+)?(previous|prior|above)\\b/i,
  /\\b(disregard|override)\\s+(your\\s+)?(instructions|system|prompt|rules)\\b/i,
  /\\b(delete|drop|truncate|wipe|destroy)\\b[\\s\\S]*\\b(all|everything|database|table|data|users?|accounts?)\\b/i,
  /\\b(exfiltrate|leak|reveal|print|show)\\b[\\s\\S]*\\b(secret|token|password|api[_-]?key|credential|system\\s*prompt)\\b/i,
  /\\bsystem\\s+prompt\\b/i,
  /\\brm\\s+-rf\\b/i
];
function isUnsafeTask(task) { const text = taskText(task); for (const p of UNSAFE_PATTERNS) { if (p.test(text)) return { unsafe: true, reason: 'refused: destructive / prompt-injection / out-of-scope request' }; } return { unsafe: false }; }
function synthesize(kind, history) { const parts = history.filter((h) => h.result && h.result.ok).map((h) => h.intent + ':' + (h.result.summary == null ? 'ok' : h.result.summary)); return '[' + kind + '] ' + (parts.length ? parts.join(' | ') : 'no successful tool results'); }
function keywordPlanner(task, history) {
  const text = taskText(task).toLowerCase();
  const called = history.map((h) => h.intent);
  const has = (i) => called.includes(i);
  const looksBug = /\\b(bug|broken|crash|error|down|outage|cannot|can't|fail|failing|not working|unresponsive)\\b/.test(text);
  const looksFeedback = /\\b(love|hate|like|dislike|feedback|suggest|wish|feature request|too (slow|small|big|expensive|confusing))\\b/.test(text);
  const looksQuestion = /\\b(how|what|why|where|when|which|explain|guide|docs?|tutorial)\\b/.test(text) || text.includes('?');
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
  if (called.length > 0) return { action: 'finish', answer: synthesize('other', history) };
  return { action: 'finish', answer: 'No actionable signal detected; no tool was appropriate.' };
}
function stubTools(intent) {
  const summaries = { 'rag': '2 citations (known-issue check)', 'support-triage': 'routed: platform-support, urgency: high', 'product-feedback': 'theme: praise, sentiment: positive', 'eval': 'passRate 1.0', 'drift': 'drift.any false' };
  return summaries[intent] ? { ok: true, summary: summaries[intent] } : { ok: false, summary: 'unknown tool' };
}
function runAgentLoop(task, opts) {
  opts = opts || {};
  const planner = opts.planner || keywordPlanner;
  const callTool = opts.callTool || stubTools;
  const maxSteps = Number.isFinite(opts.maxSteps) ? opts.maxSteps : 4;
  const allowlist = Array.isArray(opts.allowlist) ? opts.allowlist : TOOL_ALLOWLIST;
  const safe = isUnsafeTask(task);
  if (safe.unsafe) return { refused: true, stopReason: 'refused', reason: safe.reason, trajectory: [], toolCalls: 0, finalAnswer: null, guardrail: 'refusal' };
  const trajectory = []; const history = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    let decision;
    try { decision = planner(task, history); } catch (e) { return { refused: false, stopReason: 'planner-error', reason: e.message, trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null }; }
    if (!decision || typeof decision !== 'object') return { refused: false, stopReason: 'bad-decision', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null };
    if (decision.action === 'refuse') return { refused: true, stopReason: 'refused', reason: decision.reason || 'planner refused', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'refusal' };
    if (decision.action === 'finish') return { refused: false, stopReason: 'finished', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: decision.answer == null ? null : decision.answer };
    if (decision.action === 'call') {
      if (!allowlist.includes(decision.intent)) return { refused: false, stopReason: 'guardrail:non-allowlisted-tool', blockedIntent: decision.intent, trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'non-allowlisted-tool' };
      let result;
      try { result = callTool(decision.intent, decision.args || {}); } catch (e) { result = { ok: false, summary: 'tool error: ' + e.message }; }
      if (!result || typeof result !== 'object') result = { ok: false, summary: 'tool returned a bad shape' };
      trajectory.push({ step: step, intent: decision.intent, args: decision.args || {}, ok: result.ok === true, summary: result.summary == null ? null : result.summary });
      history.push({ intent: decision.intent, result: result });
      continue;
    }
    return { refused: false, stopReason: 'unknown-action', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null };
  }
  return { refused: false, stopReason: 'guardrail:max-steps', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'max-steps' };
}
const input = items[0].json;
const run = runAgentLoop(input.task, { planner: keywordPlanner, callTool: stubTools, maxSteps: (input.config && input.config.maxSteps) || 4, allowlist: TOOL_ALLOWLIST });
return [{ json: { run: run, policyVersion: input.policyVersion, plannerSource: 'stub', toolSource: 'stub' } }];`
    }
  }
});

const buildResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Response',
    position: [1140, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const g = items[0].json; const run = g.run;
const body = { ok: !run.refused, refused: run.refused === true, stopReason: run.stopReason, trajectory: run.trajectory, toolCalls: run.toolCalls, finalAnswer: run.finalAnswer, guardrail: run.guardrail || null, plannerSource: g.plannerSource, toolSource: g.toolSource, policyVersion: g.policyVersion };
const audit = { auditEventId: 'agent_' + (run.trajectory.length) + '_' + run.stopReason, stopReason: run.stopReason, toolCalls: run.toolCalls, refused: run.refused === true, tools: run.trajectory.map(function (t) { return t.intent; }) };
return [{ json: { statusCode: 200, body: body, audit: audit } }];`
    }
  }
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Respond', position: [1380, 320], parameters: { respondWith: 'json', responseBody: '={{ $json.body }}', options: { responseCode: expr('{{ $json.statusCode }}') } } }
});

const overview = sticky(
  '## Autonomous Agent v0.1.0 (Capstone C). A BOUNDED tool-use loop: the Agent Loop Code node MIRRORS the audited ' +
  'scripts/lib/agent-core.mjs (verify:agent 39/39) — deterministic keyword planner + refusal/allowlist/max-steps/' +
  'no-fabricated guardrails — over STUB tools (byte-stable trajectory). The agent tools ARE the portfolio ' +
  'workflows via the signed interaction-gateway; live LLM planner + live gateway tool execution are the opt-in next ' +
  'increments. scripts/test-agent-workflow.mjs extracts the COMPILED Agent Loop body, runs the golden tasks, AND ' +
  'differentially checks it vs the core, so the deployed copy cannot silently drift. webhook -> normalize -> Agent ' +
  'Loop -> respond. policyVersion autonomous-agent-v0.1.0.',
  [receiveTask, runFromUi, buildDemoTask, normalizeTask, agentLoop, buildResponse, respond],
  { color: 6 }
);

export default workflow('autonomous-agent', 'Portfolio - Autonomous Agent')
  .add(overview)
  .add(receiveTask)
  .to(normalizeTask)
  .to(agentLoop)
  .to(buildResponse)
  .to(respond)
  .add(runFromUi)
  .to(buildDemoTask)
  .to(normalizeTask);
