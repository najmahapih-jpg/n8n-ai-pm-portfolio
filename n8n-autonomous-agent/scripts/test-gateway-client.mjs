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

// (B) FORWARD: an opts.traceId is added to the envelope BEFORE signing — present in the exact signed bytes, and the
// signature covers it (recomputed independently). When traceId is ABSENT the bytes are byte-identical to before.
const signedTrace = buildSignedRequest('rag', { query: 'x' }, { signingSecret: 'test-secret', requestId: 'r1', timestamp: '1700000000', traceId: 'trace-agent-123' });
check('traceId is in the exact signed envelope bytes', signedTrace.rawBody === '{"intent":"rag","payload":{"query":"x"},"requestId":"r1","traceId":"trace-agent-123"}', signedTrace.rawBody);
const expectedSigTrace = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update('1700000000.' + signedTrace.rawBody).digest('hex');
check('signature covers the traceId-bearing body (independent HMAC)', signedTrace.signature === expectedSigTrace);
check('absent traceId -> byte-identical envelope (no behavior change)', signed.rawBody === '{"intent":"rag","payload":{"query":"x"},"requestId":"r1"}');

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
check('POST body = signed envelope (rag tries LIVE first: retrievalSource=supabase)', captured.init.body === '{"intent":"rag","payload":{"retrievalSource":"supabase","query":"x"},"requestId":"r1"}', captured.init.body);

// rag RETRY-ON-DEGRADE: a live call that degrades to a *-fallback abstain triggers ONE retry with stub.
const ragCalls = [];
const degradeThenHit = async (_url, init) => {
  ragCalls.push(JSON.parse(init.body).payload.retrievalSource);
  const body = (ragCalls.length === 1)
    ? { ok: true, result: { executed: true, perTarget: [{ target: 'rag', result: { statusCode: 200, response: { abstained: true, retrievalSource: 'supabase-fallback', citations: [] } } }] } }
    : { ok: true, result: { executed: true, perTarget: [{ target: 'rag', result: { statusCode: 200, response: { abstained: false, retrievalSource: 'stub', citations: [{ chunkId: 'known-export-mobile-crash' }] } } }] } };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
const retried = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: degradeThenHit })('rag', { query: 'export broken' });
check('rag degrade -> retried with stub (2 calls: supabase then stub)', ragCalls.length === 2 && ragCalls[0] === 'supabase' && ragCalls[1] === 'stub', ragCalls.join('->'));
check('rag retry returns the reliable stub hit', retried.ok === true && /retrievalSource=stub/.test(retried.summary) && /abstained=false/.test(retried.summary), retried.summary);

// a CLEAN live hit (not a fallback) is NOT retried (1 call only).
let cleanCalls = 0;
const cleanHit = async () => { cleanCalls += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { executed: true, perTarget: [{ target: 'rag', result: { statusCode: 200, response: { abstained: false, retrievalSource: 'supabase', citations: [{ chunkId: 'known-export-mobile-crash' }] } } }] } }) }; };
await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: cleanHit })('rag', { query: 'export broken' });
check('clean live hit -> no retry (1 call)', cleanCalls === 1, 'calls=' + cleanCalls);

// non-rag intent: 1 call, no retrievalSource injected, no retry.
const stCalls = [];
const stFetch = async (_url, init) => { stCalls.push(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { executed: true, perTarget: [{ target: 'support-triage', result: { statusCode: 200, response: { routingTeam: 'x' } } }] } }) }; };
await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: stFetch })('support-triage', { subject: 's' });
check('non-rag: 1 call, no retrievalSource', stCalls.length === 1 && !/retrievalSource/.test(stCalls[0]), stCalls[0]);

// (B)+(C) traceId end-to-end via the tool factory: an opts.traceId is signed into the POST body (forwarded to the
// gateway), AND the gateway's RESPONSE traceId is captured onto the tool result (so the agent's trajectory step can
// correlate to the gateway/sibling run). A non-rag intent is used so the body is a single, exact signed envelope.
let traceBody = null;
const traceFetch = async (_url, init) => { traceBody = init.body; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, traceId: 'gw-echoed-123', result: { executed: true, perTarget: [{ target: 'support-triage', result: { statusCode: 200, response: { routingTeam: 'x' } } }] } }) }; };
const traceOut = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: traceFetch, now: () => 1700000000, makeRequestId: () => 'r1', traceId: 'trace-agent-123' })('support-triage', { subject: 's' });
check('(B) agent traceId is in the signed POST body', traceBody === '{"intent":"support-triage","payload":{"subject":"s"},"requestId":"r1","traceId":"trace-agent-123"}', traceBody);
check('(C) gateway response traceId captured on result.traceId', traceOut.traceId === 'gw-echoed-123', 'traceId=' + traceOut.traceId);
check('(C) gateway response traceId also on data.traceId', traceOut.data.traceId === 'gw-echoed-123', 'data.traceId=' + traceOut.data.traceId);
// No agent traceId -> the body omits traceId (byte-identical to the pre-feature envelope); a captured response traceId is null when none echoed.
let noTraceBody = null;
const noTraceFetch = async (_url, init) => { noTraceBody = init.body; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { executed: true, perTarget: [{ target: 'support-triage', result: { statusCode: 200, response: { routingTeam: 'x' } } }] } }) }; };
const noTraceOut = await makeGatewayCallTool({ gatewayUrl: 'http://gw.local/x', signingSecret: 's', fetchImpl: noTraceFetch, now: () => 1700000000, makeRequestId: () => 'r1' })('support-triage', { subject: 's' });
check('no agent traceId -> body omits traceId (byte-identical envelope)', noTraceBody === '{"intent":"support-triage","payload":{"subject":"s"},"requestId":"r1"}', noTraceBody);
check('no echoed traceId -> result.traceId null', noTraceOut.traceId === null, 'traceId=' + noTraceOut.traceId);

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
