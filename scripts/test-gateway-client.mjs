// test-gateway-client.mjs — offline proof of the gateway tool executor (npm run verify:gateway-client; in
// verify:static). With an INJECTED stub fetch (no network), it pins: (1) the signed envelope's exact bytes +
// signature format (independently recomputed), (2) the request wiring (text/plain + X-Timestamp + X-Signature +
// the exact signed body), (3) response parsing into { ok, summary, data }, and (4) failure handling (HTTP error /
// transport throw / non-JSON -> ok:false, never a fabricated success). The LIVE call is proven by
// test-agent-gateway-live.mjs; here the only thing NOT exercised is the real gateway's verdict.
import crypto from 'node:crypto';
import { buildSignedRequest, summarizeTarget, makeGatewayCallTool } from './lib/gateway-client.mjs';

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + label + (detail ? ' -> ' + detail : ''));
}

// (1) buildSignedRequest — exact envelope bytes + signature format, deterministic, independently verifiable.
const signed = buildSignedRequest('rag', { query: 'x' }, { signingSecret: 'test-secret', requestId: 'r1', timestamp: '1700000000' });
check('rawBody is the exact compact envelope', signed.rawBody === '{"intent":"rag","payload":{"query":"x"},"requestId":"r1"}', signed.rawBody);
const expectedSig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update('1700000000.' + signed.rawBody).digest('hex');
check('signature == independent HMAC over `ts.rawBody`', signed.signature === expectedSig, signed.signature.slice(0, 22) + '...');
check('signature uses the sha256= prefix', signed.signature.startsWith('sha256='));
const signed2 = buildSignedRequest('rag', { query: 'x' }, { signingSecret: 'test-secret', requestId: 'r1', timestamp: '1700000000' });
check('signing is deterministic', signed.signature === signed2.signature);
check('a different secret changes the signature', buildSignedRequest('rag', { query: 'x' }, { signingSecret: 'other', requestId: 'r1', timestamp: '1700000000' }).signature !== signed.signature);

// (2)+(3) makeGatewayCallTool — request wiring + response parsing, via a stub fetch that captures the request.
const cannedRag = { ok: true, traceId: 'gw-agent-0001', intent: 'rag', routedTo: ['rag'], result: { mode: 'live', executed: true, fanout: false, perTarget: [{ target: 'rag', result: { statusCode: 200, response: { ok: true, abstained: true, answer: null, citations: [], passed: true } } }] } };
let captured = null;
const stubFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify(cannedRag) }; };
const callTool = makeGatewayCallTool({ gatewayUrl: 'http://gw.local/webhook/portfolio/interaction-gateway', signingSecret: 'test-secret', fetchImpl: stubFetch, now: () => 1700000000, makeRequestId: () => 'r1' });
const out = await callTool('rag', { query: 'x' });
check('callTool parses executed result -> ok:true', out.ok === true && out.data.executed === true, 'ok=' + out.ok);
check('summary carries the sibling digest', /rag:/.test(out.summary) && /abstained=true/.test(out.summary), out.summary);
check('POST used Content-Type text/plain', captured.init.headers['Content-Type'] === 'text/plain');
check('POST sent X-Timestamp + X-Signature(sha256=)', captured.init.headers['X-Timestamp'] === '1700000000' && /^sha256=/.test(captured.init.headers['X-Signature']));
check('POST body is the exact signed envelope', captured.init.body === '{"intent":"rag","payload":{"query":"x"},"requestId":"r1"}', captured.init.body);

// (4) failure handling — never a fabricated success.
const httpErr = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }) })('rag', {});
check('HTTP 500 -> ok:false', httpErr.ok === false, httpErr.summary);
const throwErr = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })('rag', {});
check('transport throw -> ok:false (unreachable)', throwErr.ok === false && /unreachable/.test(throwErr.summary), throwErr.summary);
const badJson = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })('rag', {});
check('non-JSON -> ok:false', badJson.ok === false, badJson.summary);
// decision-only response (executed:false) -> ok:false, labeled.
const decisionOnly = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, routedTo: ['support-triage'], result: { executed: false } }) }) })('support-triage', {});
check('decision-only (executed:false) -> ok:false', decisionOnly.ok === false, decisionOnly.summary);
// a sibling that EXECUTED but returned its own 4xx is a TOOL FAILURE -> ok:false (honest; data.executed stays true).
const siblingErr = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, traceId: 't', routedTo: ['support-triage'], result: { executed: true, perTarget: [{ target: 'support-triage', result: { statusCode: 400, response: { error: 'bad payload' } } }] } }) }) })('support-triage', {});
check('sibling 4xx (executed but errored) -> ok:false, executed:true', siblingErr.ok === false && siblingErr.data.executed === true, 'ok=' + siblingErr.ok);

// summarizeTarget directly (sibling-agnostic digest).
check('summarizeTarget product-feedback shape', summarizeTarget('product-feedback', { response: { theme: 'praise', sentiment: 'positive' } }) === 'product-feedback: theme=praise, sentiment=positive');

console.log('');
console.log('gateway-client self-test: ' + pass + ' passed, ' + fail + ' failed (OFFLINE, stub fetch; signing + wiring + parsing + failure handling)');
process.exit(fail > 0 ? 1 : 0);
