import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

// Interaction Gateway v0.1.0 — a generic, signed-webhook edge for the n8n Workflow-as-Code portfolio.
//
// One authenticated POST entry point that VERIFIES -> SIZE-LIMITS -> SECRET-STRIPS -> ROUTES a request to
// the right business workflow(s) by an allowlisted intent, so each business workflow keeps its clean JSON
// contract and the gateway owns the production-edge controls. The four security functions are the SINGLE
// SOURCE OF TRUTH in scripts/lib/gateway-core.mjs (proven 20/20 by verify:gateway); the Code nodes below
// MIRROR them inline (n8n Code nodes cannot import the .mjs). scripts/test-gateway-workflow.mjs extracts
// each Code node's body from the COMPILED JSON and (a) runs the eval-plan's 13 golden scenarios against it
// and (b) differentially pins the four security gates against gateway-core.mjs (verdicts, reasons, whole-body
// strip), so the deployed security logic cannot silently drift from the audited core.
//
// PIPELINE ORDER (size-before-signature on purpose: reject an oversized body BEFORE spending crypto):
//   webhook -> normalize -> enforceBodySize(413) -> verifySignature(401) -> stripSecrets -> resolveRoute(422)
//   -> routeToSiblings(decision) -> buildResponse -> respondToWebhook
// Each gate computes its verdict in JS and only FLIPS the first failure (statusCode 401/413/422); the
// response code lives in the Code-node output (testable offline), and the respond node merely echoes it.
//
// The security pipeline runs for EVERY request; v0.4.0 routes a CALLABLE intent IN-PROCESS via a DYNAMIC
// Execute-Workflow (no secret over HTTP) and wraps the real result(s) — incl. MULTI-TARGET FAN-OUT (one intent →
// N callable siblings via executeWorkflow mode 'each', results collected per-target). Proven live vs the selftest
// sibling, the real product-feedback SUT, and a 2-sibling fan-out. Non-callable intents stay decision-only.
// v0.5.0 adds the UNIFIED NOTIFICATION OUTLET: intent 'notify' -> the feishu-notify sibling (same in-process
// Execute-Workflow path), so one signed request posts a Feishu group card and no caller ever holds the
// Feishu webhook URL/secret.
// SSRF is closed BY CONSTRUCTION: callers name an intent, never a URL,
// and security CONFIG (secret, body cap, replay window, live-mode) comes only from env/credential — a
// webhook caller can neither loosen a cap nor force live routing.

const POLICY_VERSION = 'interaction-gateway-v0.5.0';

const receiveSignedRequest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Receive Signed Request (POST)',
    position: [180, 320],
    parameters: {
      httpMethod: 'POST',
      path: 'portfolio/interaction-gateway',
      authentication: 'none',
      responseMode: 'responseNode',
      options: { rawBody: true, allowedOrigins: '*' }
    }
  }
});

const runFromUi = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Demo From n8n UI',
    position: [180, 620]
  }
});

const buildDemoRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Signed Demo Request',
    position: [420, 620],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Editor demo: construct a VALIDLY-SIGNED envelope so a manual n8n run shows a full accepted round-trip.
// Signs with the same secret the verifier reads ($env.GATEWAY_SIGNING_SECRET, else '' when unset) so the
// demo round-trips locally without configuration. Not part of the offline suite (which drives Normalize
// directly from golden fixtures).
const crypto = require('crypto');
function envGet(name){ try { return (typeof $env !== 'undefined' && $env) ? $env[name] : undefined; } catch (e) { return undefined; } }
const secret = envGet('GATEWAY_SIGNING_SECRET') != null ? String(envGet('GATEWAY_SIGNING_SECRET')) : '';
const payload = { subject: 'Login button does nothing on mobile', message: 'Tapping sign-in is unresponsive on iOS Safari.' };
const bodyObj = { intent: 'support-triage', payload: payload, requestId: 'demo-0001' };
const rawBody = JSON.stringify(bodyObj);
const ts = Math.floor(Date.now() / 1000);
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
return [{ json: { __demo: true, rawBody: rawBody, body: bodyObj, headers: { 'x-timestamp': String(ts), 'x-signature': sig } } }];`
    }
  }
});

const normalizeRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Request',
    position: [660, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Parse the signed envelope and initialise the gateway state. SECURITY CONFIG is read from env only
// (never the untrusted body): a webhook caller cannot loosen the body cap, widen the replay window, or
// force live routing. The shared secret is NEVER copied into the state object (so it is never echoed/logged).
const src = items[0].json || {};
function envGet(name){ try { return (typeof $env !== 'undefined' && $env) ? $env[name] : undefined; } catch (e) { return undefined; } }
function hget(h, name){ if (!h) return undefined; const lower = name.toLowerCase(); for (const k of Object.keys(h)) { if (k.toLowerCase() === lower) return h[k]; } return undefined; }
function num(v, d){ const n = Number(v); return Number.isFinite(n) ? n : d; }

const isDemo = src.__demo === true;
const entrypoint = isDemo ? 'manual' : 'webhook';
const headers = src.headers || {};
// Exact-bytes rawBody for HMAC: prefer n8n's raw body; if the webhook delivered the body as an unparsed
// STRING (e.g. a text/plain post so n8n preserves the exact signed bytes), use it verbatim; only as a last
// resort re-serialize a parsed object (which a signer must then match). See docs/security-boundaries.md.
let rawBody;
if (typeof src.rawBody === 'string') { rawBody = src.rawBody; }
else if (typeof src.body === 'string') { rawBody = src.body; }
else if (src.body != null) { rawBody = JSON.stringify(src.body); }
else { rawBody = ''; }
let body = {};
try { body = (src.body && typeof src.body === 'object') ? src.body : JSON.parse(rawBody || '{}'); } catch (e) { body = {}; }

const timestamp = hget(headers, 'x-timestamp');
const signatureHeader = hget(headers, 'x-signature') || '';
const maxBytes = num(envGet('GATEWAY_MAX_BODY_BYTES'), 65536);
const windowSeconds = num(envGet('GATEWAY_REPLAY_WINDOW_SECONDS'), 300);
const now = num(envGet('GATEWAY_NOW_SECONDS'), Math.floor(Date.now() / 1000));
const mode = String(envGet('GATEWAY_MODE') || '').toLowerCase() === 'live' ? 'live' : 'stub';

const intent = (body && typeof body.intent === 'string') ? body.intent : '';
const requestId = (body && typeof body.requestId === 'string' && body.requestId) ? body.requestId : '';
const payload = (body && typeof body.payload === 'object' && body.payload) ? body.payload : {};

// intent / requestId / payload are UNTRUSTED here. The Strip node strips the WHOLE envelope (g.body) and
// finalises the ECHOED intent + the traceId from the CLEANED values, so a secret-shaped intent or requestId
// can never be reflected into the response, the audit event, or the trace id. traceId + cleanPayload are
// therefore deferred to Strip (set to '' / {} here).
const gateway = {
  policyVersion: '${POLICY_VERSION}',
  traceId: '',
  entrypoint: entrypoint,
  mode: mode,
  config: { maxBytes: maxBytes, windowSeconds: windowSeconds },
  request: { intent: intent, requestId: requestId },
  body: body,
  rawBody: rawBody,
  timestamp: (timestamp == null ? '' : String(timestamp)),
  signatureHeader: String(signatureHeader),
  payload: payload,
  now: now,
  accepted: true,
  statusCode: 200,
  error: null,
  stages: {},
  routedTo: [],
  targetIds: [],
  targetCallable: false,
  stripped: [],
  cleanPayload: {}
};
return [{ json: { gateway: gateway } }];`
    }
  }
});

const enforceBodySize = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Enforce Body Size (413)',
    position: [900, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Mirrors gateway-core.enforceBodySize. Runs FIRST so an oversized body is rejected before crypto.
const g = items[0].json.gateway;
const bytes = Buffer.byteLength(g.rawBody == null ? '' : g.rawBody, 'utf8');
g.stages.size = { ok: bytes <= g.config.maxBytes, bytes: bytes };
if (g.accepted && bytes > g.config.maxBytes) {
  g.accepted = false;
  g.statusCode = 413;
  g.error = 'payload too large: ' + bytes + ' bytes exceeds cap ' + g.config.maxBytes;
}
return [{ json: { gateway: g } }];`
    }
  }
});

const verifySignature = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Verify Signature (401)',
    position: [1140, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Mirrors gateway-core.verifySignature: timing-safe HMAC-SHA256 over (timestamp + "." + rawBody) with
// a replay window. The secret comes from env/credential ONLY — never from the request, never into state.
// crypto is required (n8n's external task-runner does not expose it as a global) — deploy needs NODE_FUNCTION_ALLOW_BUILTIN=crypto.
const crypto = require('crypto');
const g = items[0].json.gateway;
function envGet(name){ try { return (typeof $env !== 'undefined' && $env) ? $env[name] : undefined; } catch (e) { return undefined; } }
const secret = envGet('GATEWAY_SIGNING_SECRET') != null ? String(envGet('GATEWAY_SIGNING_SECRET')) : '';
function verify(rawBody, timestamp, signatureHeader, secret, nowSeconds, windowSeconds) {
  if (secret === undefined || secret === null || secret === '') return { ok: false, reason: 'gateway secret not configured' };
  if (!signatureHeader) return { ok: false, reason: 'missing signature' };
  if (timestamp === undefined || timestamp === null || timestamp === '') return { ok: false, reason: 'missing timestamp' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad timestamp' };
  const now = Number(nowSeconds);
  if (!Number.isFinite(now)) return { ok: false, reason: 'bad now' };
  if (Math.abs(now - ts) > windowSeconds) return { ok: false, reason: 'expired timestamp (replay window)' };
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(ts + '.' + String(rawBody)).digest('hex');
  const a = Buffer.from(String(signatureHeader));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  return crypto.timingSafeEqual(a, b) ? { ok: true, reason: 'ok' } : { ok: false, reason: 'signature mismatch' };
}
const v = verify(g.rawBody, g.timestamp, g.signatureHeader, secret, g.now, g.config.windowSeconds);
g.stages.signature = { ok: v.ok, reason: v.reason };
if (g.accepted && !v.ok) {
  g.accepted = false;
  g.statusCode = 401;
  g.error = 'unauthorized: ' + v.reason;
}
return [{ json: { gateway: g } }];`
    }
  }
});

const stripSecrets = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Strip Secrets',
    position: [1380, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Mirrors gateway-core.stripSecrets, run over the WHOLE envelope. Redacts any field whose KEY name or
// string VALUE (incl. a bare string array element) looks secret. Always runs (even on a rejected request)
// so a secret is NEVER forwarded, echoed, or reflected into the traceId / audit. The cleaned intent + the
// requestId-derived traceId are finalised HERE, so a secret-shaped intent/requestId cannot leak.
const crypto = require('crypto');
const g = items[0].json.gateway;
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/,
  /sb_secret_[A-Za-z0-9_-]{8,}/,
  /sb_publishable_[A-Za-z0-9_-]{8,}/,
  /Bearer\\s+[A-Za-z0-9._-]{10,}/i,
  /eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/
];
const SECRET_KEY_NAMES = /(secret|token|apikey|api_key|password|signingsecret|webhookurl|authorization|credential)/i;
function valueIsSecret(s) { return typeof s === 'string' && SECRET_VALUE_PATTERNS.some(function (p) { return p.test(s); }); }
function strip(obj) {
  const stripped = [];
  function walk(node, path) {
    if (Array.isArray(node)) return node.map(function (v, i) {
      const itemPath = path + '[' + i + ']';
      if (valueIsSecret(v)) { stripped.push(itemPath); return '[stripped]'; }
      return walk(v, itemPath);
    });
    if (node && typeof node === 'object') {
      const out = {};
      for (const entry of Object.entries(node)) {
        const k = entry[0];
        const v = entry[1];
        const keyPath = path ? path + '.' + k : k;
        if (valueIsSecret(k)) { stripped.push((path ? path + '.' : '') + '[stripped-key]'); out['[stripped-key]'] = '[stripped]'; continue; }
        if (SECRET_KEY_NAMES.test(k)) { stripped.push(keyPath); out[k] = '[stripped]'; continue; }
        if (valueIsSecret(v)) { stripped.push(keyPath); out[k] = '[stripped]'; continue; }
        out[k] = walk(v, keyPath);
      }
      return out;
    }
    return node;
  }
  return { clean: walk(obj, ''), stripped: stripped };
}
const r = strip(g.body || {});
g.body = r.clean;
g.cleanBody = r.clean;
g.stripped = r.stripped;
g.request.intent = (typeof r.clean.intent === 'string') ? r.clean.intent : '';
g.request.requestId = (typeof r.clean.requestId === 'string') ? r.clean.requestId : '';
g.cleanPayload = (r.clean.payload && typeof r.clean.payload === 'object') ? r.clean.payload : {};
g.payload = g.cleanPayload;
const safeRequestId = /^[A-Za-z0-9._-]{1,64}$/.test(g.request.requestId) ? g.request.requestId : '';
g.traceId = 'gw-' + (safeRequestId ? safeRequestId : crypto.createHash('sha256').update(String(g.now) + '.' + String(g.rawBody)).digest('hex').slice(0, 16));
g.stages.strip = { strippedCount: r.stripped.length };
return [{ json: { gateway: g } }];`
    }
  }
});

const resolveRoute = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Resolve Route (422)',
    position: [1620, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Mirrors gateway-core.resolveRoute: map an intent to 1+ allowlisted sibling targets; reject unknown /
// non-allowlisted. Callers never supply a URL/host (SSRF-closed by construction). A multi-target intent
// (feedback-then-grade) is a fan-out composition.
const g = items[0].json.gateway;
const ALLOWLIST = {
  'support-triage': ['support-triage'],
  'product-feedback': ['product-feedback'],
  'rag': ['rag'],
  'eval': ['eval-harness'],
  'drift': ['scheduled-drift-monitor'],
  'feedback-then-grade': ['product-feedback', 'eval-harness'],
  'gateway-selftest': ['gateway-selftest-sibling'],
  'feedback-multi': ['product-feedback', 'gateway-selftest-sibling'],
  'notify': ['feishu-notify']
};
// target -> n8n workflow id, ONLY for targets that expose an executeWorkflowTrigger (callable IN-PROCESS via
// Execute Workflow). Business targets stay decision-only until each gets a trigger (tracked per-sibling); the
// selftest sibling is the proven live target. Single-target live execution only in v0.2.0.
const TARGET_WORKFLOW_IDS = { 'gateway-selftest-sibling': 'yqjMTU3XHwBT8b0L', 'product-feedback': '6Gc3wmri0tJre07B', 'rag': 'jZ5Xfml8jbKexYqf', 'eval-harness': 'IhmmthDFMKdDbgvp', 'scheduled-drift-monitor': 'Gjd7wma62zubk3Wy', 'support-triage': 'RPkw9jGJ93lqs7jO', 'feishu-notify': '6QIm8x1EsmVlObKj' };
function resolve(intent, allowlist) {
  if (!intent || typeof intent !== 'string') return { ok: false, targets: [], reason: 'missing intent' };
  const targets = allowlist[intent];
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, targets: [], reason: 'non-allowlisted intent: ' + intent };
  return { ok: true, targets: targets.slice(), reason: 'ok' };
}
const r = resolve(g.request.intent, ALLOWLIST);
g.stages.route = { ok: r.ok, reason: r.reason };
if (g.accepted) {
  if (r.ok) {
    g.routedTo = r.targets;
    g.targetIds = r.targets.map(function (t) { return { target: t, id: TARGET_WORKFLOW_IDS[t] || null }; });
    // callable iff EVERY resolved target has a wired executeWorkflowTrigger id (live fan-out is all-or-nothing)
    g.targetCallable = g.targetIds.length > 0 && g.targetIds.every(function (x) { return !!x.id; });
  } else {
    g.accepted = false;
    g.statusCode = 422;
    g.error = 'unprocessable: ' + r.reason;
    g.routedTo = [];
    g.targetIds = [];
    g.targetCallable = false;
  }
}
return [{ json: { gateway: g } }];`
    }
  }
});

const routeToSiblings = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Route To Siblings (decision)',
    position: [1860, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// STUB-DEFAULT routing DECISION. v0.1.0 proves verify + size + strip + route-decision offline. Sibling
// EXECUTION is the opt-in live tier (n8n Execute Workflow, in-process, no secret over HTTP) which requires
// each target to expose an executeWorkflowTrigger — tracked as the next increment, not faked here. We record
// where the CLEAN payload (secrets already stripped) would be forwarded, with the generated traceId on every
// routed call — never a fabricated sibling result.
const g = items[0].json.gateway;
const perTarget = (g.routedTo || []).map(function (t) {
  return { target: t, forwarded: g.accepted === true, executed: false, mode: g.mode, traceId: g.traceId };
});
g.routing = {
  mode: g.mode,
  executed: false,
  note: 'routing decision only (this target has no executeWorkflowTrigger yet); callable targets execute in-process on the live-route branch',
  perTarget: perTarget,
  forwardedPayloadKeys: Object.keys(g.cleanPayload || {})
};
return [{ json: { gateway: g } }];`
    }
  }
});

const buildResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Response',
    position: [2100, 320],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Final shaping for BOTH outcomes (accepted -> 200 wrap; rejected -> 4xx error). The status code was
// decided by the gates upstream and lives here in JS (testable offline); the respond node only echoes it.
// The redacted audit event carries ids/counts/verdicts only — never the payload or any secret.
const g = items[0].json.gateway;
let body;
if (g.accepted === true) {
  body = {
    ok: true,
    traceId: g.traceId,
    intent: g.request.intent,
    routedTo: g.routedTo,
    result: g.routing,
    policyVersion: g.policyVersion
  };
} else {
  body = {
    ok: false,
    error: g.error || 'rejected',
    traceId: g.traceId,
    intent: g.request.intent || null,
    policyVersion: g.policyVersion
  };
}
const audit = {
  auditEventId: g.traceId,
  entrypoint: g.entrypoint,
  intent: g.request.intent || null,
  accepted: g.accepted === true,
  statusCode: g.statusCode,
  routedTo: g.routedTo || [],
  strippedCount: (g.stripped || []).length,
  stages: Object.keys(g.stages || {})
};
return [{ json: { statusCode: g.statusCode, body: body, audit: audit } }];`
    }
  }
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond',
    position: [2340, 320],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.body }}',
      options: { responseCode: expr('{{ $json.statusCode }}') }
    }
  }
});

const liveRouteGate = ifElse({
  version: 2.3,
  config: {
    name: 'Live Route To Sibling?',
    position: [2100, 320],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'live-callable',
          leftValue: expr('{{ $json.gateway.accepted === true && $json.gateway.targetCallable === true }}'),
          operator: { type: 'boolean', operation: 'true', singleValue: true },
          rightValue: true
        }],
        combinator: 'and'
      },
      options: {}
    }
  }
});

const prepareSiblingInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Sibling Input',
    position: [2340, 180],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Shape the in-process call: pass ONLY the cleaned (secret-stripped) payload + intent + traceId to the
// sibling — never the rawBody, signature, or gateway internals. __gw carries the response metadata we re-attach
// after the call (the Execute Workflow node replaces the item with the sibling's output).
const g = items[0].json.gateway;
const clean = g.cleanPayload || {};
const gwMeta = { traceId: g.traceId, intent: g.request.intent, routedTo: g.routedTo, policyVersion: g.policyVersion };
// FORWARD the gateway's traceId INTO the sibling 'payload' (X3 correlation keystone): a routed sibling captures
// body.traceId ?? body.requestId, where its body = source.body ?? source resolves to this 'payload' object, so it
// echoes the SAME gateway traceId back -> the gateway->sibling chain is end-to-end correlatable. We reuse the
// gateway's EXISTING traceId (never generate a new one) and provide it as requestId too (the ?? requestId
// fallback). Additive: clean is spread untouched, then traceId/requestId are layered on without dropping fields.
const siblingPayload = Object.assign({}, clean, { traceId: g.traceId, requestId: g.traceId });
// Emit ONE item per callable target -> Execute Sibling (mode 'each') invokes each IN-PROCESS; Merge collects
// per-target. Each item spreads the clean payload at top level (business siblings read e.g. feedbackText) AND
// keeps a 'payload' key (the selftest sibling reads src.payload) -- one shape, multiple sibling contracts.
// __targetId drives the dynamic workflowId; __targetName + __gw are re-read after the call. Never rawBody/signature.
return (g.targetIds || []).map(function (t) {
  return { json: Object.assign({}, clean, {
    payload: siblingPayload,
    intent: g.request.intent,
    traceId: g.traceId,
    __targetId: t.id,
    __targetName: t.target,
    __gw: gwMeta
  }) };
});`
    }
  }
});

const executeSibling = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.2,
  config: {
    name: 'Execute Sibling (in-process)',
    position: [2580, 180],
    parameters: {
      source: 'database',
      workflowId: { __rl: true, value: '={{ $json.__targetId }}', mode: 'id' },
      mode: 'each',
      options: {}
    }
  }
});

const mergeSiblingResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Merge Sibling Result',
    position: [2820, 180],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// Execute Workflow replaced the item with the sibling's output. Re-attach the gateway metadata (from
// Prepare Sibling Input) and wrap the REAL sibling result — executed:true, in-process, no secret over HTTP.
// The Execute Workflow node (mode 'each') produced one output item PER target, in input order. Correlate each
// back to its target via $('Prepare Sibling Input').all()[i], and collect per-target -- executed:true, in-process,
// no HTTP. A single-target intent yields a 1-entry perTarget; a fan-out intent yields N.
const prep = $('Prepare Sibling Input').all();
const gw = (prep[0] && prep[0].json.__gw) || {};
const perTarget = items.map(function (it, i) {
  return { target: (prep[i] && prep[i].json.__targetName) || ('idx' + i), result: it.json };
});
const body = {
  ok: true,
  traceId: gw.traceId,
  intent: gw.intent,
  routedTo: gw.routedTo,
  result: { mode: 'live', executed: true, fanout: perTarget.length > 1, perTarget: perTarget },
  policyVersion: gw.policyVersion
};
const audit = { auditEventId: gw.traceId, intent: gw.intent, routedTo: gw.routedTo, executed: true, targets: perTarget.length, statusCode: 200 };
return [{ json: { statusCode: 200, body: body, audit: audit } }];`
    }
  }
});

const respondLive = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond (live route)',
    position: [3060, 180],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json.body }}',
      options: { responseCode: expr('{{ $json.statusCode }}') }
    }
  }
});

const overview = sticky(
  '## Interaction Gateway v0.1.0 (generic SIGNED-webhook edge; stub-default + opt-in live). ' +
  'One authenticated POST entry point that VERIFIES -> SIZE-LIMITS -> SECRET-STRIPS -> ROUTES a request to ' +
  'allowlisted sibling workflow(s) by INTENT, so each business workflow keeps its clean JSON contract and the ' +
  'gateway owns the production-edge controls. The four security functions are the single source of truth in ' +
  'scripts/lib/gateway-core.mjs (verify:gateway 20/20); the Code nodes here MIRROR them inline, and ' +
  'scripts/test-gateway-workflow.mjs extracts the COMPILED Code-node bodies, runs 13 golden scenarios, and ' +
  'differentially pins the four security gates (size/signature/strip/route — verdicts, reasons, whole-body ' +
  'strip) to the .mjs, so the deployed security logic cannot silently drift. Pipeline order is ' +
  'size-before-signature on purpose (reject an oversized body before spending ' +
  'crypto): enforceBodySize -> 413, verifySignature (timing-safe HMAC over timestamp + "." + rawBody + replay ' +
  'window) -> 401, stripSecrets (key-name + value-pattern redaction; never forwarded/echoed/logged), ' +
  'resolveRoute (fixed intent -> allowlist; callers never name a URL -> SSRF-closed) -> 422. The status code ' +
  'is decided in JS (testable offline) and the respond node only echoes it. SECURITY CONFIG (secret, body ' +
  'cap, replay window, live-mode) comes from env/credential ONLY — a webhook caller can neither loosen a cap ' +
  'nor force live routing. v0.4.0 routes a CALLABLE intent IN-PROCESS via a DYNAMIC Execute-Workflow (no secret ' +
  'over HTTP) and wraps the real result(s) — incl. MULTI-TARGET FAN-OUT (one intent -> N siblings, results ' +
  'per-target); proven live vs the selftest sibling, the product-feedback SUT, and a 2-sibling fan-out. v0.5.0 adds ' +
  'the UNIFIED NOTIFICATION OUTLET: intent \'notify\' -> the feishu-notify sibling (same in-process path), so one ' +
  'signed request posts a Feishu group card and no caller ever holds the webhook URL/secret. Every routed call + the response carry a ' +
  'generated traceId (the cross-workflow trace metadata the review flagged as absent). policyVersion ' +
  'interaction-gateway-v0.5.0.',
  [receiveSignedRequest, runFromUi, buildDemoRequest, normalizeRequest, enforceBodySize, verifySignature, stripSecrets, resolveRoute, routeToSiblings, buildResponse, respond],
  { name: 'interaction-gateway overview', color: 4 }
);

export default workflow('interaction-gateway', 'Portfolio - Interaction Gateway')
  .add(overview)
  .add(receiveSignedRequest)
  .to(normalizeRequest)
  .to(enforceBodySize)
  .to(verifySignature)
  .to(stripSecrets)
  .to(resolveRoute)
  .to(liveRouteGate
    .onTrue(prepareSiblingInput.to(executeSibling).to(mergeSiblingResult).to(respondLive))
    .onFalse(routeToSiblings.to(buildResponse).to(respond))
  )
  .add(runFromUi)
  .to(buildDemoRequest)
  .to(normalizeRequest);
