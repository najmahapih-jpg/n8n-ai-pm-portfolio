// test-adapter-core.mjs — offline behavioral proof of the pure adapter core (npm run verify:core).
// No network, no Feishu, no gateway: event parsing, mention stripping, intent mapping, the gateway
// signing scheme (pinned known-vector so a drift in the HMAC contract is caught byte-for-byte),
// and reply building for every response family the gateway can return.
import { createHmac } from 'node:crypto';
import {
  parseFeishuEvent, mapMessageToIntent, buildGatewayRequest, buildReplyText, INTENT_ALLOWLIST
} from './lib/adapter-core.mjs';

let pass = 0, fail = 0;
function check(scenario, label, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + scenario + ' :: ' + label + (detail !== undefined ? ' -> ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- parseFeishuEvent ---------------------------------------------------------------------------
{
  const id = 'parse-event';
  const event = {
    sender: { sender_id: { open_id: 'ou_sender1' } },
    message: {
      message_id: 'om_msg1', chat_id: 'oc_chat1', chat_type: 'group', message_type: 'text',
      content: '{"text":"@_user_1  已知问题 export 按钮崩溃 "}',
      mentions: [{ key: '@_user_1', name: 'drift-bot' }]
    }
  };
  const p = parseFeishuEvent(event);
  check(id, 'mention token stripped + trimmed', p.text === '已知问题 export 按钮崩溃', p.text);
  check(id, 'chat/message ids extracted', p.chatId === 'oc_chat1' && p.messageId === 'om_msg1', p.chatId + '/' + p.messageId);
  check(id, 'sender open_id extracted', p.senderId === 'ou_sender1', p.senderId);
  const img = parseFeishuEvent({ message: { message_type: 'image', content: '{"image_key":"k"}', chat_id: 'oc', message_id: 'om' } });
  check(id, 'non-text message -> empty text (caller sends usage hint)', img.text === '', img.text);
  const bad = parseFeishuEvent({ message: { message_type: 'text', content: 'not-json', chat_id: 'oc', message_id: 'om' } });
  check(id, 'malformed content JSON -> empty text, no throw', bad.text === '', bad.text);
}

// --- mapMessageToIntent ---------------------------------------------------------------------------
{
  const id = 'intent-map';
  const drift = mapMessageToIntent('日报', { runSeed: 'abc', asOf: '2026-06-10' });
  check(id, '日报 -> drift intent', drift.intent === 'drift', drift.intent);
  check(id, 'drift payload carries runId seed + asOf', drift.payload.runId === 'feishu_abc' && drift.payload.asOf === '2026-06-10', JSON.stringify(drift.payload));
  check(id, 'drift keyword (en) -> drift', mapMessageToIntent('run drift now').intent === 'drift', '');
  check(id, '自检 -> gateway-selftest', mapMessageToIntent('来个自检').intent === 'gateway-selftest', '');
  const q = mapMessageToIntent('导出按钮为什么崩溃?');
  check(id, 'free question -> rag with text as query', q.intent === 'rag' && q.payload.query === '导出按钮为什么崩溃?', JSON.stringify(q.payload));
  check(id, 'rag payload requests live retrieval (rag X4 falls back to stub on a live miss)', q.payload.retrievalSource === 'supabase', q.payload.retrievalSource);
  check(id, 'empty text -> null intent (usage hint)', mapMessageToIntent('  ').intent === null, '');
  check(id, 'every mapped intent is allowlisted', ['日报', 'selftest', 'anything'].every((t) => { const m = mapMessageToIntent(t); return m.intent === null || INTENT_ALLOWLIST.includes(m.intent); }), '');
}

// --- buildGatewayRequest (signing contract, pinned vector) ----------------------------------------
{
  const id = 'gateway-sign';
  const req = buildGatewayRequest('req-1', 'rag', { query: 'hi' }, 'test-secret', '1700000000');
  const expectedBody = '{"requestId":"req-1","intent":"rag","payload":{"query":"hi"}}';
  check(id, 'rawBody is canonical JSON', req.rawBody === expectedBody, req.rawBody);
  const expectedSign = 'sha256=' + createHmac('sha256', 'test-secret').update('1700000000.' + expectedBody).digest('hex');
  check(id, 'X-Signature == HMAC-SHA256 hex over `${ts}.${rawBody}`', req.headers['X-Signature'] === expectedSign, req.headers['X-Signature']);
  check(id, 'X-Timestamp echoed', req.headers['X-Timestamp'] === '1700000000', req.headers['X-Timestamp']);
  check(id, 'Content-Type is text/plain (exact-bytes signing)', req.headers['Content-Type'] === 'text/plain', req.headers['Content-Type']);
  let threw = false;
  try { buildGatewayRequest('r', 'support-triage', {}, 's', '1'); } catch { threw = true; }
  check(id, 'non-allowlisted intent throws (fail closed)', threw, '');
}

// --- buildReplyText --------------------------------------------------------------------------------
{
  const id = 'reply';
  const fail401 = buildReplyText('rag', { ok: false, status: 401 });
  check(id, 'gateway failure -> honest failure reply', /未通过网关/.test(fail401) && /401/.test(fail401), fail401);

  // REAL gateway shape (caught live 2026-06-10): rag's executeWorkflow output is the FULL record
  // { statusCode, runtime, response } — the reply builder must unwrap .response or a HIT reads as
  // an abstain (every field undefined). This fixture pins the real nested shape.
  const ragHit = buildReplyText('rag', {
    ok: true, traceId: 'gw-t1',
    result: { perTarget: [{ target: 'rag', result: { statusCode: 200, runtime: { queryLang: 'zh' }, response: { ok: true, abstained: false, retrievalSource: 'supabase', answer: '已知问题:导出在移动端崩溃,2.4 修复。', citations: [{ chunkId: 'known-export-mobile-crash', source: 'Internal KB' }] } } }] }
  });
  check(id, 'rag hit (REAL nested gateway shape) -> answer + citation + traceId', /已知问题/.test(ragHit) && /known-export-mobile-crash/.test(ragHit) && /gw-t1/.test(ragHit), ragHit.slice(0, 80));
  check(id, 'rag hit surfaces the actual retrieval source (observability)', /\(retrieval supabase\)/.test(ragHit), ragHit.slice(-60));
  check(id, 'rag hit is NOT misread as abstain (the unwrap bug)', !/没有足够的信息/.test(ragHit), '');

  const ragHitBare = buildReplyText('rag', {
    ok: true,
    result: { perTarget: [{ target: 'rag', result: { abstained: false, retrievalSource: 'stub', answer: { text: '答案。', citations: [{ chunkId: 'c1', source: 's' }] } } }] }
  });
  check(id, 'rag hit (legacy bare shape) still parsed', /答案/.test(ragHitBare) && /c1/.test(ragHitBare), ragHitBare.slice(0, 60));

  const ragAbstain = buildReplyText('rag', { ok: true, result: { perTarget: [{ target: 'rag', result: { statusCode: 200, response: { abstained: true, retrievalSource: 'supabase-fallback-stub', note: 'Not enough information to answer' } } }] } });
  check(id, 'rag abstain (nested shape) -> honest abstain reply (never fabricates)', /没有足够的信息/.test(ragAbstain), ragAbstain);
  check(id, 'rag abstain surfaces the degrade retrieval source', /supabase-fallback-stub/.test(ragAbstain), ragAbstain.slice(-60));

  const driftReply = buildReplyText('drift', {
    ok: true, traceId: 'gw-t2',
    result: { perTarget: [{ target: 'scheduled-drift-monitor', result: { feishuDelivery: { status: 'sent' }, run: { runId: 'r1', drift: { any: false } } } }] }
  });
  check(id, 'drift reply -> verdict + card delivery status', /无漂移/.test(driftReply) && /sent/.test(driftReply), driftReply);

  const decisionOnly = buildReplyText('rag', { ok: true, routedTo: ['rag'], result: {} });
  check(id, 'decision-only (no execution) reported honestly', /未执行目标工作流/.test(decisionOnly), decisionOnly);
}

console.log('');
console.log('adapter-core self-test: ' + pass + ' passed, ' + fail + ' failed (OFFLINE: parse/intent/sign/reply, no network)');
process.exit(fail > 0 ? 1 : 0);
