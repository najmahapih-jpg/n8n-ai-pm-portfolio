// test-agent-core.mjs — offline agent-trajectory eval (npm run verify:agent).
//
// Grades the autonomous agent on golden tasks with the DETERMINISTIC stub planner + stub tools, plus guardrail
// NEGATIVES (refusal / non-allowlisted-tool / max-steps / no-fabricated-result). The same scoreTrajectory rubric
// will grade a LIVE LLM planner — that is the non-deterministic-agent eval thesis. No n8n, no network.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgentLoop, scoreTrajectory, keywordPlanner, parsePlannerResponse, makeLlmPlanner, calibratePlanner, makeLlmClassifierPlanner, parseClassifyResponse, routeByClass } from './lib/agent-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, '..', 'fixtures', 'golden');

// Deterministic stub tools (offline). In production these ARE the portfolio workflows via the signed gateway.
function stubTools(intent) {
  const summaries = {
    'rag': '2 citations (known-issue check)',
    'support-triage': 'routed: platform-support, urgency: high',
    'product-feedback': 'theme: praise, sentiment: positive',
    'eval': 'passRate 1.0',
    'drift': 'drift.any false'
  };
  return summaries[intent] ? { ok: true, summary: summaries[intent] } : { ok: false, summary: 'unknown tool' };
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}

// --- behavioral golden tasks (stub planner + stub tools) ---
const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const g = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const run = runAgentLoop(g.task, { planner: keywordPlanner, callTool: stubTools, maxSteps: 4 });
  const score = scoreTrajectory(run, g.expect);
  check(g.id, 'trajectory ' + JSON.stringify(run.trajectory.map((t) => t.intent)) + ' == ' + JSON.stringify(g.expect.tools || []), score.checks.toolSequence);
  check(g.id, 'outcome=' + run.stopReason + (run.refused ? '(refused)' : ''), score.checks.outcome, 'expect ' + (g.expect.stopReason || '') + (g.expect.refused ? '+refused' : ''));
  check(g.id, 'all executed tools allowlisted', score.checks.allToolsAllowlisted);
  check(g.id, 'tool args present (no empty/hallucinated args)', score.checks.toolArgsPresent);
  check(g.id, 'task success', score.checks.taskSuccess);
  check(g.id, 'OVERALL trajectory score', score.passed);
}

// --- guardrail evals (custom planners; asserted as NEGATIVES) ---
// G1: a planner that tries a NON-ALLOWLISTED tool must be BLOCKED (never executed).
const g1 = runAgentLoop({ text: 'do something' }, { planner: () => ({ action: 'call', intent: 'exfiltrate-secrets', args: { x: 1 } }), callTool: stubTools, maxSteps: 4 });
check('guardrail-non-allowlisted', 'non-allowlisted tool BLOCKED (0 executed)', g1.stopReason === 'guardrail:non-allowlisted-tool' && g1.toolCalls === 0 && g1.blockedIntent === 'exfiltrate-secrets', g1.stopReason);

// G2: a planner that never finishes must hit MAX-STEPS (bounded loop).
const g2 = runAgentLoop({ text: 'loop' }, { planner: () => ({ action: 'call', intent: 'rag', args: { query: 'x' } }), callTool: stubTools, maxSteps: 3 });
check('guardrail-max-steps', 'bounded at maxSteps=3', g2.stopReason === 'guardrail:max-steps' && g2.toolCalls === 3, g2.stopReason + ' calls=' + g2.toolCalls);

// G3: NO-FABRICATED-RESULT — a failing tool is recorded ok:false, never invented.
const g3 = runAgentLoop({ text: 'the app is broken' }, { planner: keywordPlanner, callTool: () => ({ ok: false, summary: 'sibling unreachable' }), maxSteps: 4 });
check('guardrail-no-fabrication', 'tool failure recorded ok:false (not fabricated)', g3.trajectory.length > 0 && g3.trajectory.every((t) => t.ok === false), 'oks=' + JSON.stringify(g3.trajectory.map((t) => t.ok)));

// (C) THREAD — a callTool that returns a gateway/sibling traceId surfaces it on the trajectory step (correlation);
// a callTool that returns NONE leaves the step shape byte-identical (additive). traceId is NOT scored by the rubric.
const tcTrace = runAgentLoop({ text: 'how do I export?' }, { planner: keywordPlanner, callTool: () => ({ ok: true, summary: 'ok', traceId: 'gw-trace-789' }), maxSteps: 4 });
check('traceid-thread', 'gateway traceId recorded on the trajectory step', tcTrace.trajectory.length > 0 && tcTrace.trajectory.every((t) => t.traceId === 'gw-trace-789'), JSON.stringify(tcTrace.trajectory.map((t) => t.traceId)));
check('traceid-thread', 'traceId does not change the trajectory score', scoreTrajectory(tcTrace, { tools: ['rag'], stopReason: 'finished', refused: false }).passed);
const tcNone = runAgentLoop({ text: 'how do I export?' }, { planner: keywordPlanner, callTool: () => ({ ok: true, summary: 'ok' }), maxSteps: 4 });
check('traceid-thread', 'no tool traceId -> step omits traceId (byte-identical, additive)', tcNone.trajectory.every((t) => !('traceId' in t)), JSON.stringify(tcNone.trajectory[0]));

// --- LLM-planner machinery (OFFLINE, with an INJECTED stub chat) — proves the prompt -> parse -> loop -> rubric
// path with a deterministic chat, so the LIVE script's only new variable is the real LLM's output, not the plumbing.
// P1: parse robustness — fenced/prose/garbage all yield a SAFE shape; garbage -> no-op finish, never a fabricated call.
check('llm-parse', 'plain JSON call parsed', (() => { const d = parsePlannerResponse('{"action":"call","intent":"rag","args":{"query":"x"}}'); return d.action === 'call' && d.intent === 'rag' && d.args.query === 'x'; })());
check('llm-parse', 'fenced JSON tolerated', (() => { const d = parsePlannerResponse('```json\n{"action":"finish","answer":"done"}\n```'); return d.action === 'finish' && d.answer === 'done'; })());
check('llm-parse', 'prose-wrapped JSON tolerated', (() => { const d = parsePlannerResponse('Sure! {"action":"refuse","reason":"unsafe"} hope that helps'); return d.action === 'refuse'; })());
check('llm-parse', 'garbage -> safe no-op finish (no fabricated call)', (() => { const d = parsePlannerResponse('I think maybe call rag?'); return d.action === 'finish' && d.parseError === true; })());
check('llm-parse', 'unknown action -> safe finish', (() => { const d = parsePlannerResponse('{"action":"hack","intent":"rag"}'); return d.action === 'finish'; })());

// P2: a FAITHFUL stub LLM (returns the keyword policy as JSON) drives the SAME trajectory through makeLlmPlanner.
const faithfulChat = (_prompt, ctx) => JSON.stringify(keywordPlanner(ctx.task, ctx.history));
const llmPlanner = makeLlmPlanner({ chat: faithfulChat });
for (const f of files) {
  const g = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const run = runAgentLoop(g.task, { planner: llmPlanner, callTool: stubTools, maxSteps: 4 });
  check('llm-' + g.id, 'LLM-planner trajectory ' + JSON.stringify(run.trajectory.map((t) => t.intent)) + ' scores', scoreTrajectory(run, g.expect).passed, run.stopReason);
}

// P3: a HALLUCINATING stub LLM (off-allowlist intent) is BLOCKED by the loop guardrail — the LLM plans, the loop bounds.
const badRun = runAgentLoop({ text: 'do a thing' }, { planner: makeLlmPlanner({ chat: () => '{"action":"call","intent":"exfiltrate-secrets","args":{"x":1}}' }), callTool: stubTools, maxSteps: 4 });
check('llm-guardrail', 'LLM hallucinated tool BLOCKED (0 executed)', badRun.stopReason === 'guardrail:non-allowlisted-tool' && badRun.toolCalls === 0, badRun.stopReason);

// P4: a THROWING chat degrades to a safe finish (no crash, no fabricated call).
const throwRun = runAgentLoop({ text: 'hello there' }, { planner: makeLlmPlanner({ chat: () => { throw new Error('ollama down'); } }), callTool: stubTools, maxSteps: 4 });
check('llm-resilience', 'chat error -> safe finish, 0 tools', throwRun.stopReason === 'finished' && throwRun.toolCalls === 0, throwRun.stopReason);

// P5: CALIBRATION GUARD (mirrors A's judge-drift) — the faithful LLM agrees with golden at 1.0 -> trust high; a
// deliberately-wrong planner trips it (trust low), proving the guard actually discriminates.
const golden = files.map((f) => JSON.parse(readFileSync(join(goldenDir, f), 'utf8')));
const cal = calibratePlanner(golden, { planner: llmPlanner, callTool: stubTools });
check('llm-calibration', 'faithful-LLM agreement ' + cal.agree + '/' + cal.total + ' -> trust=' + cal.trust, cal.agreement === 1 && cal.trust === 'high');
const wrongCal = calibratePlanner(golden, { planner: () => ({ action: 'finish', answer: 'always finish, never act' }), callTool: stubTools });
check('llm-calibration', 'wrong planner -> trust=low (guard discriminates)', wrongCal.trust === 'low' && wrongCal.agreement < 1, wrongCal.agree + '/' + wrongCal.total + ' agree');

// P6: CLASSIFIER planner (LLM classifies once, deterministic routeByClass owns the multi-step flow) — proves the
// classify -> route -> loop path with a stub classifier. This is the architecture that lets a SMALL model pass the
// same rubric (the live calibration compares it head-to-head with free-form step planning).
const classifyStub = (_p, ctx) => {
  const t = (typeof ctx.task === 'string' ? ctx.task : String(ctx.task.text || '') + ' ' + String(ctx.task.subject || '')).toLowerCase();
  let label = 'none';
  if (/\b(bug|broken|crash|error|down|outage|not working)\b/.test(t)) label = 'bug';
  else if (/\b(love|hate|feedback|suggest|wish|feature|too slow)\b/.test(t)) label = 'feedback';
  else if (/\b(how|what|why|where|when|explain)\b/.test(t) || t.includes('?')) label = 'question';
  return JSON.stringify({ label });
};
const calCls = calibratePlanner(golden, { planner: makeLlmClassifierPlanner({ chat: classifyStub }), callTool: stubTools });
check('llm-classifier', 'classifier-planner agreement ' + calCls.agree + '/' + calCls.total + ' -> trust=' + calCls.trust, calCls.agreement === 1 && calCls.trust === 'high');
check('llm-classifier', 'parseClassifyResponse: garbage -> none', parseClassifyResponse('uhh dunno') === 'none');
check('llm-classifier', 'parseClassifyResponse: fenced label parsed', parseClassifyResponse('```json\n{"label":"bug"}\n```') === 'bug');
check('llm-classifier', 'routeByClass bug @step1 -> rag', routeByClass('bug', { text: 'x is broken' }, []).intent === 'rag');
check('llm-classifier', 'routeByClass bug after rag+triage -> finish', routeByClass('bug', { text: 'x is broken' }, [{ intent: 'rag' }, { intent: 'support-triage' }]).action === 'finish');

console.log('');
console.log('agent-core self-test: ' + pass + ' passed, ' + fail + ' failed (' + files.length + ' golden tasks + 3 guardrail negatives + traceId-thread + LLM-planner machinery [free-form parse/integration/calibration + classifier route], OFFLINE, deterministic)');
process.exit(fail > 0 ? 1 : 0);
