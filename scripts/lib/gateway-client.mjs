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
export function buildSignedRequest(intent, payload, opts) {
  const requestId = String(opts.requestId);
  const timestamp = String(opts.timestamp);
  const secret = opts.signingSecret;
  const envelope = { intent, payload: payload || {}, requestId };
  const rawBody = JSON.stringify(envelope);
  const signature = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(timestamp + '.' + rawBody).digest('hex');
  return { rawBody, signature, timestamp, requestId, envelope };
}

// Digest one sibling's per-target result into a short, sibling-agnostic summary for the agent's trajectory.
export function summarizeTarget(target, targetResult) {
  const resp = (targetResult && targetResult.response) ? targetResult.response : targetResult;
  const frags = [];
  const keys = ['theme', 'sentiment', 'urgency', 'priorityScore', 'routingTeam', 'abstained', 'passed', 'passRate'];
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
  let seq = 0;
  const makeRequestId = opts.makeRequestId || (() => 'agent-' + String(++seq).padStart(4, '0'));
  if (!gatewayUrl) throw new Error('makeGatewayCallTool requires gatewayUrl');
  if (signingSecret === undefined || signingSecret === null || signingSecret === '') throw new Error('makeGatewayCallTool requires signingSecret');
  if (typeof fetchImpl !== 'function') throw new Error('makeGatewayCallTool requires a fetch implementation');

  return async function callTool(intent, args) {
    const { rawBody, signature, timestamp } = buildSignedRequest(intent, args, { signingSecret, requestId: makeRequestId(), timestamp: now() });
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
    const summary = perTarget.length
      ? perTarget.map((t) => summarizeTarget(t.target, t.result)).join(' | ')
      : (json && json.routedTo ? 'routedTo ' + JSON.stringify(json.routedTo) + ' (not executed)' : 'no result');
    return { ok: json.ok === true && executed && siblingsOk, summary, data: { traceId: json.traceId, routedTo: json.routedTo, executed, siblingsOk, perTarget } };
  };
}
