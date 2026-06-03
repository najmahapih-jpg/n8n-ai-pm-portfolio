// test-gateway-workflow.mjs — offline behavioral proof of the COMPILED interaction-gateway workflow.
// (npm run verify:workflow; also run inside verify:static.)
//
// Why this exists: n8n Code nodes cannot import gateway-core.mjs, so the deployed security logic is a COPY
// embedded as jsCode. verify:gateway proves the .mjs LIBRARY; this proves the DEPLOYED workflow. It:
//   1) loads the compiled CANONICAL JSON (the deploy artifact),
//   2) extracts each Code node's jsCode and runs the eval-plan's golden scenarios through the real pipeline
//      (Normalize -> EnforceBodySize -> VerifySignature -> StripSecrets -> ResolveRoute -> RouteToSiblings
//       -> BuildResponse), threading each node's output into the next exactly as n8n would,
//   3) DIFFERENTIALLY checks each gate's verdict against gateway-core.mjs on the same inputs.
// So the deployed security gates can't silently drift from the audited core. No n8n, no network.
import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifySignature, enforceBodySize, stripSecrets, resolveRoute } from './lib/gateway-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'interaction-gateway.canonical.json');
const goldenDir = join(repoRoot, 'fixtures', 'golden');

const wf = JSON.parse(readFileSync(canonicalPath, 'utf8'));
const nodeByName = {};
for (const n of wf.nodes) { nodeByName[n.name] = n; }

const NORMALIZE = 'Normalize Request';
const SIZE = 'Enforce Body Size (413)';
const SIGNATURE = 'Verify Signature (401)';
const STRIP = 'Strip Secrets';
const ROUTE = 'Resolve Route (422)';
const COMPOSE = 'Route To Siblings (decision)';
const BUILD = 'Build Response';
const PIPELINE = [NORMALIZE, SIZE, SIGNATURE, STRIP, ROUTE, COMPOSE, BUILD];

function runNode(name, items, env) {
  const node = nodeByName[name];
  if (!node) { throw new Error('missing Code node in compiled JSON: ' + name); }
  // Mirror n8n's Code-node sandbox: items[], crypto (node:crypto), Buffer, $env. The body ends in `return`.
  const fn = new Function('items', 'crypto', 'Buffer', '$env', node.parameters.jsCode);
  return fn(items, crypto, Buffer, env);
}

let pass = 0;
let fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail ? ' -> ' + detail : ''));
}

// Build the normalized webhook input from a declarative fixture request (the client's serialization +
// signing), so the test exercises the real verify path rather than trusting a hand-written signature.
function prepareInput(req, env) {
  const bodyObj = { intent: req.intent };
  if (req.payload !== undefined) { bodyObj.payload = req.payload; }
  if (req.requestId !== undefined) { bodyObj.requestId = req.requestId; }
  let rawBody = JSON.stringify(bodyObj);
  const headers = {};
  if (req.timestamp !== undefined && req.timestamp !== null) { headers['x-timestamp'] = String(req.timestamp); }
  const secret = env.GATEWAY_SIGNING_SECRET != null ? String(env.GATEWAY_SIGNING_SECRET) : '';
  if (req.sign && !req.omitSignature) {
    headers['x-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(req.timestamp + '.' + rawBody).digest('hex');
  } else if (typeof req.signature === 'string') {
    headers['x-signature'] = req.signature;
  }
  // Tamper AFTER signing: the stored rawBody no longer matches the signed bytes -> verify must reject.
  if (typeof req.tamperAfterSign === 'string') { rawBody = rawBody + req.tamperAfterSign; }
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch (e) { parsed = bodyObj; }
  return { rawBody: rawBody, body: parsed, headers: headers };
}

const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const g = JSON.parse(readFileSync(join(goldenDir, f), 'utf8'));
  const env = g.env || {};
  const exp = g.expect || {};
  const input = prepareInput(g.request, env);

  let items = [{ json: input }];
  const snap = {};
  let crashed = false;
  try {
    for (const stage of PIPELINE) {
      items = runNode(stage, items, env);
      if (!Array.isArray(items) || !items[0] || !items[0].json) { throw new Error(stage + ' returned a bad item shape'); }
      // DEEP-CLONE the snapshot: the nodes mutate one shared gateway object in place (n8n threads the same
      // item), so without a clone every snapshot would alias the FINAL mutated state and the differential
      // would compare an already-cleaned body against itself. The clone captures the state AT this stage.
      snap[stage] = structuredClone(items[0].json);
    }
  } catch (e) {
    check(g.id, 'pipeline executes', false, e.message);
    crashed = true;
  }
  if (crashed) { continue; }

  const final = snap[BUILD];                 // { statusCode, body, audit }
  const gw = snap[COMPOSE].gateway;          // gateway state just before Build Response
  const gw0 = snap[NORMALIZE].gateway;       // normalized inputs (for differential)

  // --- behavioral assertions against the DEPLOYED jsCode ---
  check(g.id, 'statusCode == ' + exp.statusCode, final.statusCode === exp.statusCode, 'got ' + final.statusCode);
  if (exp.ok !== undefined) { check(g.id, 'body.ok == ' + exp.ok, final.body.ok === exp.ok, 'got ' + final.body.ok); }
  if (exp.routedTo !== undefined) { check(g.id, 'routedTo == ' + JSON.stringify(exp.routedTo), JSON.stringify(final.body.routedTo || gw.routedTo) === JSON.stringify(exp.routedTo), JSON.stringify(final.body.routedTo || gw.routedTo)); }
  if (exp.routedToLength !== undefined) { check(g.id, 'routedTo.length == ' + exp.routedToLength, ((final.body.routedTo || gw.routedTo) || []).length === exp.routedToLength); }
  if (exp.notRouted) { check(g.id, 'NOT routed (routedTo empty + nothing executed)', (gw.routedTo || []).length === 0 && gw.routing.executed === false, JSON.stringify(gw.routedTo)); }
  if (exp.ok === true) { check(g.id, 'routing is decision-only (executed=false)', final.body.result && final.body.result.executed === false); }
  if (exp.traceIdNonEmpty) { check(g.id, 'traceId present + echoed', typeof final.body.traceId === 'string' && final.body.traceId.length > 0 && final.body.traceId === gw.traceId, final.body.traceId); }
  if (exp.traceId !== undefined) { check(g.id, 'traceId == ' + exp.traceId + ' (requestId-derived)', final.body.traceId === exp.traceId, final.body.traceId); }
  if (exp.strippedCountMin !== undefined) { check(g.id, 'strippedCount >= ' + exp.strippedCountMin, (gw.stripped || []).length >= exp.strippedCountMin, 'got ' + (gw.stripped || []).length); }
  if (exp.noSecretInOutput) {
    const serialized = JSON.stringify(final);
    const leak = /sb_secret_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(serialized);
    check(g.id, 'no secret in response/audit', !leak, leak ? 'LEAK DETECTED' : 'clean');
  }

  // --- differential: deployed jsCode verdict MUST equal gateway-core.mjs on the same inputs ---
  const secret = env.GATEWAY_SIGNING_SECRET != null ? String(env.GATEWAY_SIGNING_SECRET) : '';
  const coreSize = enforceBodySize(gw0.rawBody, gw0.config.maxBytes);
  check(g.id, 'DIFF size == core (ok+bytes)', snap[SIZE].gateway.stages.size.ok === coreSize.ok && snap[SIZE].gateway.stages.size.bytes === coreSize.bytes);
  const coreSig = verifySignature(gw0.rawBody, gw0.timestamp, gw0.signatureHeader, secret, gw0.now, gw0.config.windowSeconds);
  check(g.id, 'DIFF signature == core (ok+reason)', snap[SIGNATURE].gateway.stages.signature.ok === coreSig.ok && snap[SIGNATURE].gateway.stages.signature.reason === coreSig.reason, 'node="' + snap[SIGNATURE].gateway.stages.signature.reason + '" core="' + coreSig.reason + '"');
  // strip is differentially pinned over the WHOLE envelope (not just payload): same raw input -> same clean out.
  const coreStrip = stripSecrets(gw0.body || {});
  check(g.id, 'DIFF strip count == core', (snap[STRIP].gateway.stripped || []).length === coreStrip.stripped.length, 'node=' + (snap[STRIP].gateway.stripped || []).length + ' core=' + coreStrip.stripped.length);
  check(g.id, 'DIFF strip clean(whole body) == core', JSON.stringify(snap[STRIP].gateway.cleanBody) === JSON.stringify(coreStrip.clean));
  // route differential is fed the SAME (cleaned) intent the node routed on, so ok AND reason are pinned.
  const coreRoute = resolveRoute(snap[STRIP].gateway.request.intent);
  check(g.id, 'DIFF route == core (ok+reason)', snap[ROUTE].gateway.stages.route.ok === coreRoute.ok && snap[ROUTE].gateway.stages.route.reason === coreRoute.reason);
}

console.log('');
console.log('gateway-workflow behavioral self-test: ' + pass + ' passed, ' + fail + ' failed (' + files.length + ' golden scenarios, OFFLINE, compiled jsCode + differential vs core)');
process.exit(fail > 0 ? 1 : 0);
