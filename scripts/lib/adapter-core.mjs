// adapter-core.mjs — the PURE deterministic core of the Feishu inbound adapter. Everything here is
// side-effect-free and offline-testable (verify:core); the WebSocket/HTTP shell (src/adapter.mjs)
// only wires these functions to the live Feishu SDK + the local signed gateway.
//
// Security model: the adapter holds NO business logic and NO privileged access beyond what any
// gateway client has — it maps a chat message to an ALLOWLISTED gateway intent and signs the
// request with the SAME HMAC scheme the gateway edge verifies (sha256 hex over `${ts}.${rawBody}`,
// 'sha256=' prefix). Unknown text falls back to the rag intent (a question), never to an
// arbitrary target; the gateway's own intent allowlist remains the final authority.
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------------------------
// parseFeishuEvent — extract the useful parts of an im.message.receive_v1 event payload.
// Feishu delivers message.content as a JSON STRING (e.g. '{"text":"@_user_1 hello"}'); mentions
// appear in the text as @_user_N placeholder tokens that must be stripped before intent mapping.
// Non-text messages (images, cards, ...) yield text:'' and the caller replies with a usage hint.
// ---------------------------------------------------------------------------------------------
export function parseFeishuEvent(event) {
  const msg = event && event.message && typeof event.message === 'object' ? event.message : {};
  let text = '';
  if (msg.message_type === 'text' && typeof msg.content === 'string') {
    try {
      const parsed = JSON.parse(msg.content);
      text = typeof parsed.text === 'string' ? parsed.text : '';
    } catch { text = ''; }
  }
  text = text.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    text,
    messageType: String(msg.message_type || ''),
    chatId: String(msg.chat_id || ''),
    messageId: String(msg.message_id || ''),
    chatType: String(msg.chat_type || ''),
    senderId: String(event && event.sender && event.sender.sender_id && event.sender.sender_id.open_id ? event.sender.sender_id.open_id : '')
  };
}

// ---------------------------------------------------------------------------------------------
// mapMessageToIntent — keyword routing to an ALLOWLISTED gateway intent. Deliberately small:
//   drift keywords  -> 'drift'           (on-demand health digest; also lands a Feishu card)
//   selftest        -> 'gateway-selftest' (pipeline ping)
//   anything else   -> 'rag' with the text as the query (the portfolio's known-issue brain)
// Empty text (non-text message, bare mention) -> null intent; the caller replies with usage.
// ---------------------------------------------------------------------------------------------
export const INTENT_ALLOWLIST = ['drift', 'gateway-selftest', 'rag'];

export function mapMessageToIntent(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) { return { intent: null, payload: null, reason: 'empty text' }; }
  const lower = t.toLowerCase();
  if (/(^|\s)(drift|体检|日报|漂移)(\s|$)/.test(lower)) {
    const payload = { runId: 'feishu_' + String(opts.runSeed || 'run'), };
    if (opts.asOf) { payload.asOf = String(opts.asOf); }
    return { intent: 'drift', payload, reason: 'drift keyword' };
  }
  if (/(selftest|自检)/.test(lower)) {
    return { intent: 'gateway-selftest', payload: { ping: t }, reason: 'selftest keyword' };
  }
  return { intent: 'rag', payload: { query: t }, reason: 'default question -> rag' };
}

// ---------------------------------------------------------------------------------------------
// buildGatewayRequest — the EXACT signing scheme the interaction-gateway edge verifies (and that
// the autonomous agent's gateway-client uses): HMAC-SHA256 hex over the EXACT bytes `${ts}.${rawBody}`,
// sent as 'X-Signature: sha256=<hex>' + 'X-Timestamp: <ts>' with Content-Type text/plain.
// ts is injected (unix seconds as string) so this stays deterministic under test.
// ---------------------------------------------------------------------------------------------
export function buildGatewayRequest(requestId, intent, payload, secret, ts) {
  if (!INTENT_ALLOWLIST.includes(intent)) { throw new Error('intent not allowlisted: ' + intent); }
  const rawBody = JSON.stringify({ requestId: String(requestId), intent, payload: payload || {} });
  const sign = 'sha256=' + createHmac('sha256', String(secret)).update(String(ts) + '.' + rawBody).digest('hex');
  return {
    rawBody,
    headers: { 'X-Timestamp': String(ts), 'X-Signature': sign, 'Content-Type': 'text/plain' }
  };
}

// ---------------------------------------------------------------------------------------------
// buildReplyText — turn a gateway response into a short, honest chat reply. Defensive against
// shape variance; NEVER fabricates content: when the gateway reports a failure it says so, when
// rag abstains it says so. Returns plain text (the live shell wraps it for the IM API).
// ---------------------------------------------------------------------------------------------
export function buildReplyText(intent, gatewayResponse) {
  const g = gatewayResponse && typeof gatewayResponse === 'object' ? gatewayResponse : {};
  if (g.ok !== true) {
    return '⚠️ 请求未通过网关 (status ' + String(g.status ?? '?') + (g.error ? ': ' + String(g.error).slice(0, 120) : '') + ')';
  }
  const perTarget = g.result && Array.isArray(g.result.perTarget) ? g.result.perTarget : [];
  const first = perTarget.length > 0 && perTarget[0] && typeof perTarget[0].result === 'object' ? perTarget[0].result : null;
  const trace = g.traceId ? '\n(traceId ' + String(g.traceId) + ')' : '';

  if (!first) {
    return '✅ 网关已受理 (routedTo ' + JSON.stringify(g.routedTo || []) + ', 未执行目标工作流)' + trace;
  }

  if (intent === 'rag') {
    const run = first; // rag returns its response record directly
    const abstained = run.abstained === true || (run.answer && run.answer.abstained === true);
    const answerText = typeof run.answer === 'string' ? run.answer
      : (run.answer && typeof run.answer.text === 'string' ? run.answer.text : '');
    const citations = Array.isArray(run.citations) ? run.citations
      : (run.answer && Array.isArray(run.answer.citations) ? run.answer.citations : []);
    if (abstained || (!answerText && citations.length === 0)) {
      return '🤷 知识库没有足够的信息回答这个问题(诚实弃答,不编造)。' + trace;
    }
    const cites = citations.slice(0, 3).map((c) => {
      const id = c && (c.chunkId || c.id) ? String(c.chunkId || c.id) : '';
      const src = c && c.source ? String(c.source) : '';
      return '· ' + id + (src ? ' — ' + src.slice(0, 60) : '');
    }).join('\n');
    return (answerText ? String(answerText).slice(0, 800) : '(检索命中,见引用)') + (cites ? '\n\n引用:\n' + cites : '') + trace;
  }

  if (intent === 'drift') {
    const run = first.run && typeof first.run === 'object' ? first.run : first;
    const driftAny = !!(run.drift && run.drift.any);
    const head = driftAny ? '🚨 检测到漂移' : '✅ 无漂移';
    const fd = first.feishuDelivery && first.feishuDelivery.status ? String(first.feishuDelivery.status) : 'unknown';
    return head + ' (runId ' + String(run.runId || '?') + ')。完整简报卡片投递: ' + fd + '。' + trace;
  }

  return '✅ 已执行 ' + intent + ',结果摘要: ' + JSON.stringify(first).slice(0, 400) + trace;
}
