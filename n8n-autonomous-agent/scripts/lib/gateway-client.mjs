// gateway-client.mjs — the agent's REAL tool executor: a callTool(intent, args) that SIGNS a request and routes it
// to the DEPLOYED interaction-gateway (intent -> in-process sibling execution -> real result), instead of stub
// tools. This is the capstone's last mile: the agent's tools ARE the portfolio workflows, reached via the signed
// gateway (no secret over HTTP beyond an HMAC; the agent names an allowlisted INTENT, never a URL -> SSRF-closed at
// the gateway). PURE seam: fetchImpl / now / makeRequestId / signingSecret are INJECTED, so the signing + request
// wiring + response parsing are offline-testable with a stub fetch (test-gateway-client.mjs); the live run hits the
// real gateway (test-agent-gateway-live.mjs). The agent's intents (support-triage / product-feedback / rag / eval /
// drift) ARE the gateway's allowlist keys verbatim — no remapping.
import crypto from 'node:crypto';

// Build the EXACT signed request the deployed gateway verifies. rawBody = compact JSON { intent, payload, requestId }
// (the exact signed bytes; the client POSTs it as text/plain so n8n leaves it unparsed). signature = 'sha256=' +
// HMAC-SHA256(secret, `${timestamp}.${rawBody}`). PURE — no network, no env, deterministic given its inputs.
//
// (B) FORWARD: when the caller supplies opts.traceId, it is added to the envelope BEFORE serializing + signing (so
// the gateway captures it via body.traceId and forwards it to the sub-sibling). The signature covers the EXACT bytes,
// so traceId is signed correctly. When opts.traceId is absent the envelope + signed bytes are byte-identical to before.
export function buildSignedRequest(intent, payload, opts) {
  const requestId = String(opts.requestId);
  const timestamp = String(opts.timestamp);
  const secret = opts.signingSecret;
  const envelope = { intent, payload: payload || {}, requestId };
  if (opts.traceId != null) envelope.traceId = String(opts.traceId);
  const rawBody = JSON.stringify(envelope);
  const signature = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(timestamp + '.' + rawBody).digest('hex');
  return { rawBody, signature, timestamp, requestId, envelope };
}

// Digest one sibling's per-target result into a short, sibling-agnostic summary for the agent's trajectory.
export function summarizeTarget(target, targetResult) {
  const resp = (targetResult && targetResult.response) ? targetResult.response : targetResult;
  const frags = [];
  const keys = ['retrievalSource', 'theme', 'sentiment', 'urgency', 'priorityScore', 'routingTeam', 'abstained', 'passed', 'passRate'];
  for (const k of keys) { if (resp && resp[k] !== undefined && resp[k] !== null) frags.push(k + '=' + resp[k]); }
  if (resp && Array.isArray(resp.citations)) frags.push('citations=' + resp.citations.length);
  if (resp && resp.drift && resp.drift.any !== undefined) frags.push('drift.any=' + resp.drift.any);
  if (resp && resp.digestIntegrity !== undefined) frags.push('digestIntegrity=' + resp.digestIntegrity);
  if (!frags.length && targetResult && targetResult.statusCode) frags.push('statusCode ' + targetResult.statusCode);
  return target + ': ' + (frags.length ? frags.join(', ') : 'ok');
}

// Wrap the deployed gateway into a callTool(intent, args) -> { ok, summary, data } the agent loop can use directly.
// On a transport/HTTP/parse error it returns { ok:false, ... } (the loop records it faithfully — no fabrication).
export function makeGatewayCallTool(opts) {
  const gatewayUrl = opts.gatewayUrl;
  const signingSecret = opts.signingSecret;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const now = opts.now || (() => Math.floor(Date.now() / 1000));
  // (B) FORWARD: the agent's run-level correlation id. When present it is signed into EVERY gateway request body so
  // the gateway captures it (body.traceId) and forwards it to the sub-sibling. null/absent -> byte-identical to before.
  const agentTraceId = opts.traceId != null ? String(opts.traceId) : null;
  let seq = 0;
  const makeRequestId = opts.makeRequestId || (() => 'agent-' + String(++seq).padStart(4, '0'));
  if (!gatewayUrl) throw new Error('makeGatewayCallTool requires gatewayUrl');
  if (signingSecret === undefined || signingSecret === null || signingSecret === '') throw new Error('makeGatewayCallTool requires signingSecret');
  if (typeof fetchImpl !== 'function') throw new Error('makeGatewayCallTool requires a fetch implementation');

  // One signed round-trip to the gateway -> { ok, summary, traceId, data }. data.degradedAbstain flags a rag live
  // call that transiently degraded (retrievalSource '*-fallback') AND abstained — the signal the retry below acts on.
  async function callOnce(intent, sendArgs) {
    const { rawBody, signature, timestamp } = buildSignedRequest(intent, sendArgs, { signingSecret, requestId: makeRequestId(), timestamp: now(), traceId: agentTraceId });
    let res;
    let text;
    try {
      res = await fetchImpl(gatewayUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Timestamp': String(timestamp), 'X-Signature': signature }, body: rawBody });
      text = await res.text();
    } catch (e) {
      return { ok: false, summary: 'gateway unreachable: ' + (e && e.message ? e.message : 'error'), data: null };
    }
    if (!res.ok) return { ok: false, summary: 'gateway http ' + res.status, data: { status: res.status, body: String(text).slice(0, 200) } };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, summary: 'gateway returned non-JSON', data: null }; }
    const executed = !!(json && json.result && json.result.executed === true);
    const perTarget = (json && json.result && Array.isArray(json.result.perTarget)) ? json.result.perTarget : [];
    // A sibling that EXECUTED but returned its own 4xx/5xx is a TOOL FAILURE, not a success (the agent's payload
    // didn't satisfy that sibling's contract). Reflect it honestly: ok requires every sibling's statusCode < 400.
    const siblingsOk = perTarget.length > 0 && perTarget.every((t) => {
      const sc = t && t.result ? t.result.statusCode : undefined;
      return sc === undefined || sc === null || Number(sc) < 400;
    });
    const r0 = (perTarget.length && perTarget[0].result) ? (perTarget[0].result.response || perTarget[0].result) : null;
    const degradedAbstain = !!(r0 && typeof r0.retrievalSource === 'string' && /-fallback$/.test(r0.retrievalSource) && r0.abstained === true);
    const summary = perTarget.length
      ? perTarget.map((t) => summarizeTarget(t.target, t.result)).join(' | ')
      : (json && json.routedTo ? 'routedTo ' + JSON.stringify(json.routedTo) + ' (not executed)' : 'no result');
    // (C) THREAD: surface the gateway's RESPONSE traceId at the top level so the agent loop records it on the
    // trajectory step (correlating the agent run to the gateway/sibling run). null when the gateway echoed none.
    const respTraceId = (json && json.traceId != null) ? json.traceId : null;
    return { ok: json.ok === true && executed && siblingsOk, summary, traceId: respTraceId, data: { traceId: respTraceId, routedTo: json.routedTo, executed, siblingsOk, degradedAbstain, perTarget } };
  }

  return async function callTool(intent, args) {
    const baseArgs = args || {};
    // rag tool policy: try the LIVE knowledge base (real Supabase embeddings) FIRST; if the in-process call
    // transiently degrades to a *-fallback abstain (~25% of runs), retry ONCE with the deterministic stub TF-IDF
    // over the SAME corpus (a reliable hit). So the agent gets real embeddings when available AND never suffers a
    // transient miss. (The deeper fix — rag's own supabase-onError falling back to TF-IDF instead of abstaining —
    // would make this client retry unnecessary and benefit every caller; deferred, as it touches rag's live
    // Supabase-injected workflow.)
    if (intent === 'rag') {
      const live = await callOnce('rag', Object.assign({ retrievalSource: 'supabase' }, baseArgs));
      if (live.data && live.data.degradedAbstain) {
        return await callOnce('rag', Object.assign({ retrievalSource: 'stub' }, baseArgs));
      }
      return live;
    }
    return callOnce(intent, baseArgs);
  };
}
