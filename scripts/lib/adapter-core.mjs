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
//   anything else   -> 'rag' with the text as the query (the portfolio's known-issue brain).
//                      The rag payload requests retrievalSource:'supabase' (real multilingual
//                      embeddings — short colloquial zh/en questions hit semantically where the
//                      stub TF-IDF cannot); rag's OWN live-degrade fallback ('supabase-fallback-
//                      stub', X4) drops to deterministic TF-IDF over the same corpus on any live
//                      miss, so this can never produce a transient false abstain.
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
  return { intent: 'rag', payload: { query: t, retrievalSource: 'supabase' }, reason: 'default question -> rag' };
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

function clampText(value, limit) {
  const s = String(value ?? '').trim();
  if (s.length <= limit) { return s; }
  return s.slice(0, Math.max(0, limit - 12)).trimEnd() + '...';
}

function textPayload(text) {
  const fallbackText = String(text ?? '');
  return { msg_type: 'text', content: { text: fallbackText }, fallbackText };
}

function unwrapFirstTarget(gatewayResponse) {
  const g = gatewayResponse && typeof gatewayResponse === 'object' ? gatewayResponse : {};
  const perTarget = g.result && Array.isArray(g.result.perTarget) ? g.result.perTarget : [];
  return perTarget.length > 0 && perTarget[0] && typeof perTarget[0].result === 'object'
    ? perTarget[0].result
    : null;
}

function unwrapRagRun(first) {
  if (!first || typeof first !== 'object') { return null; }
  return first.response && typeof first.response === 'object' ? first.response : first;
}

function buildRagFallbackText(run, traceId) {
  const rs = run && run.retrievalSource ? '\n(retrieval ' + String(run.retrievalSource) + ')' : '';
  const trace = traceId ? '\n(traceId ' + String(traceId) + ')' : '';
  const abstained = run && (run.abstained === true || (run.answer && run.answer.abstained === true));
  const answerText = typeof (run && run.answer) === 'string' ? run.answer
    : (run && run.answer && typeof run.answer.text === 'string' ? run.answer.text : '');
  const citations = Array.isArray(run && run.citations) ? run.citations
    : (run && run.answer && Array.isArray(run.answer.citations) ? run.answer.citations : []);

  if (abstained || (!answerText && citations.length === 0)) {
    return '知识库没有足够的信息回答这个问题(诚实弃答,不编造)。' + rs + trace;
  }
  const cites = citations.slice(0, 3).map((c) => {
    const id = c && (c.chunkId || c.id) ? String(c.chunkId || c.id) : '';
    const src = c && c.source ? String(c.source) : '';
    return '- ' + id + (src ? ' — ' + src.slice(0, 60) : '');
  }).join('\n');
  return (answerText ? clampText(answerText, 800) : '(检索命中,见引用)')
    + (cites ? '\n\n引用:\n' + cites : '') + rs + trace;
}

function buildRagCard(run, traceId) {
  const abstained = run.abstained === true || (run.answer && run.answer.abstained === true);
  const answerText = typeof run.answer === 'string' ? run.answer
    : (run.answer && typeof run.answer.text === 'string' ? run.answer.text : '');
  const citations = Array.isArray(run.citations) ? run.citations
    : (run.answer && Array.isArray(run.answer.citations) ? run.answer.citations : []);
  const retrieval = run.retrieval && typeof run.retrieval === 'object' ? run.retrieval : {};
  const sourceText = [
    run.retrievalSource ? 'retrieval: ' + String(run.retrievalSource) : '',
    run.generationSource ? 'generation: ' + String(run.generationSource) : '',
    typeof retrieval.maxScore === 'number' ? 'score: ' + retrieval.maxScore : '',
    typeof retrieval.threshold === 'number' ? 'threshold: ' + retrieval.threshold : '',
    traceId ? 'traceId: ' + String(traceId) : ''
  ].filter(Boolean).join(' | ');

  const elements = [];
  if (abstained) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**结果**\n当前知识库没有足够证据回答这个问题。系统已诚实弃答,没有生成答案或引用。'
      }
    });
    if (run.note) {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: clampText(run.note, 180) }] });
    }
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**回答**\n' + clampText(answerText || '(检索命中,见引用)', 1800)
      }
    });
  }

  if (citations.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**依据来源**' }
    });
    for (const [idx, c] of citations.slice(0, 3).entries()) {
      const id = c && (c.chunkId || c.id) ? String(c.chunkId || c.id) : 'chunk-' + (idx + 1);
      const source = c && c.source ? String(c.source) : 'unknown source';
      const quote = c && c.quote ? '\n> ' + clampText(c.quote, 220) : '';
      const url = c && c.url ? String(c.url) : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: String(idx + 1) + '. **' + id + '**\n' + clampText(source, 120) + quote
        }
      });
      if (url) {
        elements.push({
          tag: 'action',
          actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '打开来源 ' + String(idx + 1) },
            type: 'default',
            url
          }]
        });
      }
    }
  }

  if (sourceText) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: sourceText }] });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: abstained ? 'yellow' : 'blue',
      title: { tag: 'plain_text', content: abstained ? '知识库没有足够信息' : '知识库回答' }
    },
    elements
  };
}

// ---------------------------------------------------------------------------------------------
// buildReplyPayload — turn a gateway response into a Feishu message payload. RAG answers become an
// interactive card for scanability; every branch carries fallbackText so the live shell can degrade
// to plain text if Feishu rejects the card. The function is pure and offline-testable.
// ---------------------------------------------------------------------------------------------
export function buildReplyPayload(intent, gatewayResponse) {
  const g = gatewayResponse && typeof gatewayResponse === 'object' ? gatewayResponse : {};
  if (g.ok !== true) {
    return textPayload('请求未通过网关 (status ' + String(g.status ?? '?') + (g.error ? ': ' + String(g.error).slice(0, 120) : '') + ')');
  }
  const first = unwrapFirstTarget(g);
  const trace = g.traceId ? '\n(traceId ' + String(g.traceId) + ')' : '';

  if (!first) {
    return textPayload('网关已受理 (routedTo ' + JSON.stringify(g.routedTo || []) + ', 未执行目标工作流)' + trace);
  }

  if (intent === 'rag') {
    // Through the gateway, rag's executeWorkflow output is its FULL Build Response record
    // { statusCode, runtime, response: {...}, auditEvent } — the chat-relevant payload lives under
    // .response. Unwrap it (and keep accepting a bare response object for older/direct shapes).
    const run = unwrapRagRun(first) || {};
    const fallbackText = buildRagFallbackText(run, g.traceId || '');
    return {
      msg_type: 'interactive',
      content: buildRagCard(run, g.traceId || ''),
      fallbackText
    };
  }

  if (intent === 'drift') {
    const run = first.run && typeof first.run === 'object' ? first.run : first;
    const driftAny = !!(run.drift && run.drift.any);
    const head = driftAny ? '检测到漂移' : '无漂移';
    const fd = first.feishuDelivery && first.feishuDelivery.status ? String(first.feishuDelivery.status) : 'unknown';
    return textPayload(head + ' (runId ' + String(run.runId || '?') + ')。完整简报卡片投递: ' + fd + '。' + trace);
  }

  return textPayload('已执行 ' + intent + ',结果摘要: ' + JSON.stringify(first).slice(0, 400) + trace);
}

// ---------------------------------------------------------------------------------------------
// buildReplyText — compatibility wrapper used by older tests/callers and by card-send fallback.
// ---------------------------------------------------------------------------------------------
export function buildReplyText(intent, gatewayResponse) {
  return buildReplyPayload(intent, gatewayResponse).fallbackText;
}
