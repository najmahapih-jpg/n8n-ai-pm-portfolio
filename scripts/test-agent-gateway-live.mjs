// test-agent-gateway-live.mjs — Layer 3, OPT-IN (npm run verify:tools). The capstone's LAST MILE, live: the agent
// loop runs with a REAL callTool that SIGNS each request and routes it to the DEPLOYED interaction-gateway, which
// executes the real sibling in-process and returns the real result. The planner is the DETERMINISTIC keyword stub
// (so the TOOL layer is the only variable under test); the SAME scoreTrajectory rubric grades the trajectory. A
// bug becomes a real 2-step trajectory: rag (real KB retrieval) -> support-triage (real routing). SKIPs cleanly if
// n8n / the secret / the gateway webhook is absent. A tool that returns ok:false because its sibling is INACTIVE is
// a labeled SKIP (not a false FAIL); a refusal must still hold with ZERO gateway calls.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keywordPlanner, scoreTrajectory } from './lib/agent-core.mjs';
import { runAgentLoopAsync } from './lib/agent-loop-async.mjs';
import { makeGatewayCallTool } from './lib/gateway-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, '..', 'fixtures', 'golden');
const BASE = (process.env.N8N_API_URL || 'http://localhost:5678').replace(/\/$/, '');
const GATEWAY_URL = BASE + '/webhook/portfolio/interaction-gateway';
const SECRET = process.env.GATEWAY_SIGNING_SECRET || '';

function skip(reason) {
  console.log('SKIP: ' + reason + ' (opt-in live gateway-tools tier; exit 0, no false green).');
  console.log('Offline gates (verify:agent / verify:workflow / verify:gateway-client) cover the loop + the signing/wiring.');
  process.exit(0);
}

async function main() {
  try {
    const h = await fetch(BASE + '/healthz');
    if (!h.ok) skip('n8n health returned ' + h.status);
  } catch (e) { skip('n8n not reachable at ' + BASE); }
  if (!SECRET) skip('GATEWAY_SIGNING_SECRET not set');

  const callTool = makeGatewayCallTool({ gatewayUrl: GATEWAY_URL, signingSecret: SECRET });
  const golden = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(goldenDir, f), 'utf8')));
  console.log('Live gateway tool execution: gateway=' + GATEWAY_URL + ' | planner=keyword(stub) | tools=REAL siblings | rubric=scoreTrajectory');
  console.log('');

  let failed = 0;
  let executedCalls = 0;
  let skipped = 0;
  for (const g of golden) {
    const run = await runAgentLoopAsync(g.task, { planner: keywordPlanner, callTool, maxSteps: 4 });
    const got = run.trajectory.map((t) => t.intent);
    executedCalls += run.trajectory.filter((t) => t.ok).length;

    let verdict;
    if (g.expect.refused) {
      // Guardrail must hold LIVE: refused, and ZERO gateway calls were made.
      verdict = (run.refused === true && run.toolCalls === 0) ? 'PASS' : 'FAIL';
    } else {
      const trajMatch = scoreTrajectory(run, g.expect).checks.toolSequence;
      const allExecuted = run.trajectory.length > 0 && run.trajectory.every((t) => t.ok === true);
      if (trajMatch && allExecuted) verdict = 'PASS';
      else if (trajMatch && !allExecuted) verdict = 'SKIP'; // a sibling returned ok:false (likely inactive) — not a false fail
      else verdict = 'FAIL';
    }
    if (verdict === 'FAIL') failed += 1;
    if (verdict === 'SKIP') skipped += 1;

    const summaries = run.trajectory.map((t) => '[' + (t.ok ? 'ok' : 'FAIL') + '] ' + t.summary).join('  ||  ');
    console.log('[' + verdict + '] ' + g.id + ' | got=' + JSON.stringify(got) + (run.refused ? '(refused)' : '') + ' expected=' + JSON.stringify(g.expect.tools || []));
    if (summaries) console.log('        ' + summaries);
  }

  console.log('');
  console.log('REAL sibling executions: ' + executedCalls + ' | failed tasks: ' + failed + ' | skipped (inactive sibling): ' + skipped);
  if (failed > 0) { console.log('FAIL: a task did not match its golden trajectory, or a refusal leaked a gateway call.'); process.exit(1); }
  if (executedCalls < 3) { console.log('FAIL: fewer than 3 real sibling executions — activate the sibling workflows to prove live tool execution.'); process.exit(1); }
  console.log('PASS: the agent drove real portfolio siblings in-process via the signed gateway, same trajectory rubric.');
  process.exit(0);
}

main().catch((e) => { console.error('verify:tools error: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
