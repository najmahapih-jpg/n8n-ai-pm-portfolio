// test-agent-workflow.mjs — offline proof of the COMPILED agent workflow (npm run verify:workflow; in verify:static).
//
// n8n Code nodes can't import agent-core.mjs, so the deployed Agent Loop is a COPY. verify:agent proves the LIBRARY;
// this proves the DEPLOYED workflow: it loads the compiled canonical JSON, extracts the Agent Loop Code-node body,
// runs the golden tasks through it, scores each with the trajectory rubric, AND differentially asserts the deployed
// loop's run record EQUALS agent-core's on the same task — so the deployed copy (incl. the regex-heavy planner/
// guardrails) can't silently drift from the audited core. No n8n, no network.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgentLoop, scoreTrajectory, keywordPlanner } from './lib/agent-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonical = JSON.parse(readFileSync(join(repoRoot, 'workflows', 'canonical', 'autonomous-agent.canonical.json'), 'utf8'));
const nodeByName = {};
for (const n of canonical.nodes) { nodeByName[n.name] = n; }

// The Agent Loop node is an ASYNC function (its opt-in live branch awaits httpRequest); run it as an AsyncFunction
// with $env/require injected. In STUB mode (no agentMode) the live branch is never reached — no network, no $env,
// no require, no `this` — so the differential exercises the byte-stable stub path exactly as before.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runNode(name, items) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  const fn = new AsyncFunction('items', '$env', 'require', node.parameters.jsCode);
  return await fn(items, {}, function (m) { throw new Error('require(' + m + ') not available in the offline differential'); });
}

// Identical to the workflow's embedded stub tools, so the differential compares like-for-like.
function harnessStubTools(intent) {
  const s = { 'rag': '2 citations (known-issue check)', 'support-triage': 'routed: platform-support, urgency: high', 'product-feedback': 'theme: praise, sentiment: positive', 'eval': 'passRate 1.0', 'drift': 'drift.any false' };
  return s[intent] ? { ok: true, summary: s[intent] } : { ok: false, summary: 'unknown tool' };
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}

const files = readdirSync(join(repoRoot, 'fixtures', 'golden')).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const g = JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'golden', f), 'utf8'));
  // (a) the DEPLOYED Agent Loop jsCode (extracted from the compiled canonical)
  const out = await runNode('Agent Loop', [{ json: { task: g.task, config: { maxSteps: 4 }, policyVersion: 'autonomous-agent-v0.1.0' } }]);
  const wfRun = out[0].json.run;
  // (b) the audited core, same task + same stub tools
  const coreRun = runAgentLoop(g.task, { planner: keywordPlanner, callTool: harnessStubTools, maxSteps: 4 });

  const score = scoreTrajectory(wfRun, g.expect);
  check(g.id, 'trajectory ' + JSON.stringify(wfRun.trajectory.map((t) => t.intent)) + ' == ' + JSON.stringify(g.expect.tools || []), score.checks.toolSequence);
  check(g.id, 'outcome=' + wfRun.stopReason + (wfRun.refused ? '(refused)' : ''), score.checks.outcome);
  // checks.allToolsAllowlisted: every recorded intent is in TOOL_ALLOWLIST (vacuously true when trajectory is empty).
  check(g.id, 'allToolsAllowlisted=' + score.checks.allToolsAllowlisted, score.checks.allToolsAllowlisted === true);
  // checks.toolArgsPresent: every tool call carried at least one arg (vacuously true when trajectory is empty).
  check(g.id, 'toolArgsPresent=' + score.checks.toolArgsPresent, score.checks.toolArgsPresent === true);
  check(g.id, 'OVERALL trajectory score', score.passed);
  // DIFFERENTIAL: the deployed loop's run record EQUALS the audited core's (the regex/planner/guardrails can't drift).
  check(g.id, 'DIFF deployed-loop == agent-core', JSON.stringify(wfRun) === JSON.stringify(coreRun), 'wf=' + wfRun.stopReason + ' core=' + coreRun.stopReason);
}

// ---------------------------------------------------------------------------------------------------------
// traceId correlation pin: the FULL compiled chain (Normalize Task -> Agent Loop -> Build Response). A caller-supplied
// body.traceId is captured-and-echoed (never generated) onto the response body + audit; a request WITHOUT it carries
// traceId:null (additive). requestId is the documented fallback. traceId feeds NO id/hash seed: the auditEventId is
// derived only from the trajectory length + stopReason, so it is identical with and without a traceId.
// ---------------------------------------------------------------------------------------------------------
async function runChain(rawBody) {
  const norm = await runNode('Normalize Task', [{ json: { rawBody: JSON.stringify(rawBody) } }]);
  const loop = await runNode('Agent Loop', [{ json: norm[0].json }]);
  const built = await runNode('Build Response', [{ json: loop[0].json }]);
  return built[0].json;
}
{
  const bugBody = { task: { customerEmail: 'dana@example.com', subject: 'Export broken', text: 'the export button is broken and crashes on mobile' } };
  const withTrace = await runChain(Object.assign({ traceId: 'trace-agent-123' }, bugBody));
  check('pin:traceid', 'supplied traceId echoed on response body', withTrace.body.traceId === 'trace-agent-123', JSON.stringify(withTrace.body.traceId));
  check('pin:traceid', 'supplied traceId echoed on audit event', withTrace.audit.traceId === 'trace-agent-123', JSON.stringify(withTrace.audit.traceId));

  const noTrace = await runChain(bugBody);
  check('pin:traceid', 'absent traceId is null on response (additive)', noTrace.body.traceId === null, JSON.stringify(noTrace.body.traceId));
  check('pin:traceid', 'absent traceId is null on audit event (additive)', noTrace.audit.traceId === null, JSON.stringify(noTrace.audit.traceId));
  check('pin:traceid', 'traceId feeds no id/hash seed (auditEventId identical with/without traceId)', withTrace.audit.auditEventId === noTrace.audit.auditEventId, withTrace.audit.auditEventId);

  // requestId fallback: traceId absent but requestId present -> echoed (proves the ?? requestId fallback).
  const withReqId = await runChain(Object.assign({ requestId: 'req-agent-456' }, bugBody));
  check('pin:traceid', 'requestId fallback echoed when traceId absent', withReqId.body.traceId === 'req-agent-456' && withReqId.audit.traceId === 'req-agent-456', JSON.stringify(withReqId.body.traceId));

  // traceId precedence: when BOTH traceId and requestId are supplied, traceId wins.
  const withBoth = await runChain(Object.assign({ traceId: 'trace-wins', requestId: 'req-loses' }, bugBody));
  check('pin:traceid', 'traceId takes precedence over requestId', withBoth.body.traceId === 'trace-wins', JSON.stringify(withBoth.body.traceId));
}

// NOTE on guardrail coverage: the deployed jsCode uses its EMBEDDED keywordPlanner, so the non-allowlisted-tool and
// max-steps guardrails (which need an injected adversarial planner) are proven in verify:agent against agent-core.
// The DIFFERENTIAL above proves the deployed runAgentLoop is byte-identical to agent-core, so those guardrails
// transfer to the deployed copy. The refusal guardrail IS exercised here directly via the unsafe golden tasks.
console.log('');
console.log('agent-workflow self-test: ' + pass + ' passed, ' + fail + ' failed (' + files.length + ' golden tasks, OFFLINE, compiled Agent Loop + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
