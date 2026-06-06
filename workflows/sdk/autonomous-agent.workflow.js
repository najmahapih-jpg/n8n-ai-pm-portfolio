import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

// Autonomous Agent v0.1.0 (Capstone C) — the n8n agent loop wrapping scripts/lib/agent-core.mjs.
//
// Given an inbound signal, the agent runs a BOUNDED tool-use loop: plan -> pick an allowlisted tool (intent) ->
// call it -> observe -> decide (done? next? refuse?) -> ... -> synthesize. Its tools ARE the portfolio workflows,
// reached via the signed interaction-gateway. The agent-core is the single source of truth (verify:agent 59/59);
// the Agent Loop Code node MIRRORS it inline (n8n Code nodes can't import the .mjs), and scripts/test-agent-workflow.mjs
// extracts the COMPILED Agent Loop body, runs the golden tasks through it, AND differentially checks it vs the core
// — so the deployed copy can't silently drift. STUB-DEFAULT: runs the deterministic keyword planner over STUB
// tools (byte-stable, differential-pinned). OPT-IN agentMode=live runs a REAL LLM classifier planner (Ollama) +
// signed gateway tools from this node. Guardrails (refusal / non-allowlisted-tool / max-steps / no-fabricated-result) are proven negatives.

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
// agentMode is an opt-in request flag: 'live' runs the real LLM planner + signed gateway tools; default 'stub' is
// the deterministic, differential-pinned path. A caller can request live; it cannot widen maxSteps (env only).
const agentMode = (body.agentMode === 'live' || src.agentMode === 'live') ? 'live' : 'stub';
const normTask = { subject: String(task.subject || ''), text: String(task.text || task.message || '') };
const email = task.customerEmail || task.email; if (email) normTask.customerEmail = String(email);
return [{ json: { task: normTask, config: { maxSteps: maxSteps, agentMode: agentMode }, entrypoint: entrypoint, policyVersion: '${POLICY_VERSION}' } }];`
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
      jsCode: `// MIRRORS scripts/lib/agent-core.mjs (the audited source of truth, verify:agent 59/59). The bounded tool-use
// loop + deterministic keyword planner + refusal/allowlist/max-steps/no-fabricated guardrails. STUB tools by
// default; agentMode=live runs a REAL LLM classifier planner (Ollama) + signed gateway tools from this node.
const TOOL_ALLOWLIST = ['support-triage', 'product-feedback', 'rag', 'eval', 'drift'];
function taskText(task) { if (task == null) return ''; if (typeof task === 'string') return task; return (String(task.text == null ? '' : task.text) + ' ' + String(task.subject == null ? '' : task.subject)).trim(); }
function taskSubject(task) { if (task && typeof task === 'object' && task.subject) return String(task.subject); return taskText(task).slice(0, 60); }
function taskEmail(task) { if (task && typeof task === 'object') { if (task.customerEmail) return String(task.customerEmail); if (task.email) return String(task.email); } return 'unknown@example.com'; }
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
    if (!has('support-triage')) return { action: 'call', intent: 'support-triage', args: { customerEmail: taskEmail(task), subject: taskSubject(task), message: taskText(task) }, why: 'classify + route the ticket' };
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
// ---- LIVE machinery (opt-in agentMode:'live'); the STUB path above stays the differential-pinned default ----
const OLLAMA_URL = 'http://host.docker.internal:11434/api/chat';
const GATEWAY_URL = 'http://n8n:5678/webhook/portfolio/interaction-gateway';
const LLM_MODEL = 'llama3.2:3b';
function buildClassifyPrompt(task) {
  return ['Classify the support task into EXACTLY ONE label:', '  - "bug": something is broken / crashing / erroring / down / not working.', '  - "question": a how / what / why information request.', '  - "feedback": product feedback, a complaint, or a feature wish.', '  - "none": a greeting / status / chit-chat with no actionable request.', 'TASK subject: ' + JSON.stringify(taskSubject(task)), 'TASK text: ' + JSON.stringify(taskText(task)), 'Reply with ONE JSON object and nothing else: {"label":"bug|question|feedback|none"}'].join('\\n');
}
function parseLabel(text) {
  const raw = String(text == null ? '' : text); let obj = null; const m = raw.match(/\\{[\\s\\S]*\\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
  const label = obj && obj.label != null ? String(obj.label).toLowerCase().trim() : '';
  return ['bug', 'question', 'feedback', 'none'].indexOf(label) >= 0 ? label : 'none';
}
function routeByClass(label, task, history) {
  const called = history.map(function (h) { return h.intent; });
  if (label === 'bug') {
    if (called.indexOf('rag') < 0) return { action: 'call', intent: 'rag', args: { query: 'known issue: ' + taskText(task).slice(0, 120) } };
    if (called.indexOf('support-triage') < 0) return { action: 'call', intent: 'support-triage', args: { customerEmail: taskEmail(task), subject: taskSubject(task), message: taskText(task) } };
    return { action: 'finish', answer: synthesize('bug', history) };
  }
  if (label === 'feedback') { if (called.indexOf('product-feedback') < 0) return { action: 'call', intent: 'product-feedback', args: { feedbackText: taskText(task) } }; return { action: 'finish', answer: synthesize('feedback', history) }; }
  if (label === 'question') { if (called.indexOf('rag') < 0) return { action: 'call', intent: 'rag', args: { query: taskText(task) } }; return { action: 'finish', answer: synthesize('question', history) }; }
  return { action: 'finish', answer: 'No actionable signal detected; no tool was appropriate.' };
}
async function llmClassify(task, helpers) {
  const res = await helpers.httpRequest({ method: 'POST', url: OLLAMA_URL, body: { model: LLM_MODEL, messages: [{ role: 'user', content: buildClassifyPrompt(task) }], stream: false, format: 'json', options: { temperature: 0 } }, json: true });
  const content = res && res.message && res.message.content != null ? res.message.content : (typeof res === 'string' ? res : JSON.stringify(res));
  return parseLabel(content);
}
function summarizeTarget(target, tr) {
  const r = (tr && tr.response) ? tr.response : tr; const parts = [];
  ['retrievalSource', 'theme', 'sentiment', 'urgency', 'priorityScore', 'routingTeam', 'abstained', 'passed', 'passRate'].forEach(function (k) { if (r && r[k] != null) parts.push(k + '=' + r[k]); });
  if (r && Array.isArray(r.citations)) parts.push('citations=' + r.citations.length);
  if (!parts.length && tr && tr.statusCode != null) parts.push('statusCode ' + tr.statusCode);
  return target + ': ' + (parts.length ? parts.join(', ') : 'ok');
}
async function gatewayCall(intent, args, ctx) {
  const crypto = require('crypto');
  const ts = String(Math.floor(Date.now() / 1000)); const requestId = 'agent-node-' + ctx.seq; ctx.seq += 1;
  const rawBody = JSON.stringify({ intent: intent, payload: args || {}, requestId: requestId });
  const sig = 'sha256=' + crypto.createHmac('sha256', String(ctx.secret)).update(ts + '.' + rawBody).digest('hex');
  let resp; try { resp = await ctx.helpers.httpRequest({ method: 'POST', url: GATEWAY_URL, body: rawBody, headers: { 'Content-Type': 'text/plain', 'X-Timestamp': ts, 'X-Signature': sig } }); } catch (e) { return { ok: false, summary: 'gateway error: ' + (e && e.message ? e.message : 'failed') }; }
  let json = resp; if (typeof resp === 'string') { try { json = JSON.parse(resp); } catch (e) { return { ok: false, summary: 'gateway non-JSON' }; } }
  const executed = !!(json && json.result && json.result.executed === true);
  const perTarget = (json && json.result && Array.isArray(json.result.perTarget)) ? json.result.perTarget : [];
  const siblingsOk = perTarget.length > 0 && perTarget.every(function (t) { const sc = t && t.result ? t.result.statusCode : undefined; return sc == null || Number(sc) < 400; });
  const summary = perTarget.length ? perTarget.map(function (t) { return summarizeTarget(t.target, t.result); }).join(' | ') : 'no result';
  return { ok: (json && json.ok === true) && executed && siblingsOk, summary: summary };
}
async function runAgentLoopLive(task, opts) {
  const maxStepsL = Number.isFinite(opts.maxSteps) ? opts.maxSteps : 4;
  const safe = isUnsafeTask(task);
  if (safe.unsafe) return { refused: true, stopReason: 'refused', reason: safe.reason, trajectory: [], toolCalls: 0, finalAnswer: null, guardrail: 'refusal' };
  const trajectory = []; const history = []; const ctx = { helpers: opts.helpers, secret: opts.secret, seq: 1 };
  for (let step = 1; step <= maxStepsL; step += 1) {
    let label; try { label = await llmClassify(task, opts.helpers); } catch (e) { return { refused: false, stopReason: 'planner-error', reason: (e && e.message ? e.message : 'classify failed'), trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null }; }
    const decision = routeByClass(label, task, history);
    if (decision.action === 'finish') return { refused: false, stopReason: 'finished', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: decision.answer == null ? null : decision.answer };
    if (decision.action === 'call') {
      if (TOOL_ALLOWLIST.indexOf(decision.intent) < 0) return { refused: false, stopReason: 'guardrail:non-allowlisted-tool', blockedIntent: decision.intent, trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'non-allowlisted-tool' };
      const result = await gatewayCall(decision.intent, decision.args || {}, ctx);
      trajectory.push({ step: step, intent: decision.intent, args: decision.args || {}, ok: result.ok === true, summary: result.summary == null ? null : result.summary });
      history.push({ intent: decision.intent, result: result });
      continue;
    }
    return { refused: false, stopReason: 'unknown-action', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null };
  }
  return { refused: false, stopReason: 'guardrail:max-steps', trajectory: trajectory, toolCalls: trajectory.length, finalAnswer: null, guardrail: 'max-steps' };
}
const input = items[0].json;
const mode = (input.config && input.config.agentMode) === 'live' ? 'live' : 'stub';
const maxSteps = (input.config && input.config.maxSteps) || 4;
let run; let plannerSource; let toolSource;
if (mode === 'live') {
  const helpers = (this && this.helpers) ? this.helpers : ((typeof $helpers !== 'undefined') ? $helpers : null);
  const secret = (typeof $env !== 'undefined' && $env) ? $env.GATEWAY_SIGNING_SECRET : undefined;
  if (!helpers || typeof helpers.httpRequest !== 'function') { run = { refused: false, stopReason: 'live-unavailable', reason: 'no httpRequest helper in this runtime', trajectory: [], toolCalls: 0, finalAnswer: null }; }
  else { run = await runAgentLoopLive(input.task, { maxSteps: maxSteps, helpers: helpers, secret: secret }); }
  plannerSource = 'llm:' + LLM_MODEL; toolSource = 'gateway';
} else {
  run = runAgentLoop(input.task, { planner: keywordPlanner, callTool: stubTools, maxSteps: maxSteps, allowlist: TOOL_ALLOWLIST });
  plannerSource = 'stub'; toolSource = 'stub';
}
return [{ json: { run: run, policyVersion: input.policyVersion, plannerSource: plannerSource, toolSource: toolSource } }];`
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
  '## Autonomous Agent v0.1.0 (Capstone C). A BOUNDED tool-use loop. DEFAULT (stub): the Agent Loop Code node ' +
  'MIRRORS the audited scripts/lib/agent-core.mjs (verify:agent 59/59) — deterministic keyword planner + ' +
  'refusal/allowlist/max-steps/no-fabricated guardrails — over STUB tools (byte-stable, differential-pinned). ' +
  'OPT-IN (POST agentMode=live): this node runs a REAL LLM classifier (Ollama) + signed interaction-gateway tools ' +
  '(real in-process portfolio siblings). scripts/test-agent-workflow.mjs differentially pins the STUB path vs the ' +
  'core, so the deployed copy cannot silently drift. webhook -> normalize -> Agent Loop -> respond. ' +
  'policyVersion autonomous-agent-v0.1.0.',
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
