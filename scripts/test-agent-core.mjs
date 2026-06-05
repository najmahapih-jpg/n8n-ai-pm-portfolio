// test-agent-core.mjs — offline agent-trajectory eval (npm run verify:agent).
//
// Grades the autonomous agent on golden tasks with the DETERMINISTIC stub planner + stub tools, plus guardrail
// NEGATIVES (refusal / non-allowlisted-tool / max-steps / no-fabricated-result). The same scoreTrajectory rubric
// will grade a LIVE LLM planner — that is the non-deterministic-agent eval thesis. No n8n, no network.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgentLoop, scoreTrajectory, keywordPlanner } from './lib/agent-core.mjs';

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

console.log('');
console.log('agent-core self-test: ' + pass + ' passed, ' + fail + ' failed (' + files.length + ' golden tasks + 3 guardrail negatives, OFFLINE, deterministic)');
process.exit(fail > 0 ? 1 : 0);
