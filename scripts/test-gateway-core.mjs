// test-gateway-core.mjs — offline self-test of the gateway's pure security core (npm run verify:gateway).
// Asserts every hard-acceptance criterion as a NEGATIVE that MUST be rejected, plus the positives, so the
// security functions cannot silently no-op. No n8n, no network.
import crypto from 'node:crypto';
import { verifySignature, enforceBodySize, stripSecrets, resolveRoute } from './lib/gateway-core.mjs';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; } else { fail++; }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' -> ' + detail : ''}`);
}

const secret = 'gateway-test-secret';
const body = JSON.stringify({ intent: 'support-triage', payload: { subject: 'x' } });
const ts = 1000000;
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');

// --- signature (authenticated-by-construction) ---
check('sig-valid: correct HMAC + fresh timestamp -> ok', verifySignature(body, ts, sig, secret, ts).ok);
check('sig-tampered: body changed after signing -> 401', !verifySignature(body + 'X', ts, sig, secret, ts).ok);
check('sig-missing: no X-Signature -> 401', !verifySignature(body, ts, '', secret, ts).ok);
check('sig-expired: timestamp outside replay window -> 401', !verifySignature(body, ts, sig, secret, ts + 1000, 300).ok);
check('sig-wrong-secret -> 401', !verifySignature(body, ts, sig, 'other-secret', ts).ok);
check('sig-empty-secret -> reject (fail closed, not forgeable)', !verifySignature(body, ts, sig, '', ts).ok);
check('sig-nonfinite-now -> reject (fail closed, no replay bypass)', !verifySignature(body, ts, sig, secret, NaN).ok);

// --- body size ---
check('body-oversize: over cap -> 413', !enforceBodySize(body, 8).ok);
check('body-undersize: within cap -> ok', enforceBodySize(body, 65536).ok);

// --- secret strip (no-secret-forwarding) ---
const dirty = {
  payload: {
    subject: 'hi',
    apiKey: 'sb_secret_abcdef12345',                    // key-name AND value match
    feedback: 'my access is sk-ABCDEFGH1234',           // value-only (sk-)
    deep: { authorization: 'Bearer abcdefghij1234567' } // key-name match
  },
  supabaseUrl: 'sb_secret_zzzzzzzz9999'                  // value-only (sb_secret_)
};
const { clean, stripped } = stripSecrets(dirty);
const cleanStr = JSON.stringify(clean);
check('secret-strip: secret-bearing fields removed', stripped.length >= 4, `stripped: ${stripped.join(', ')}`);
check('secret-strip: no sb_secret_ in cleaned output', !cleanStr.includes('sb_secret_'));
check('secret-strip: no sk- token in cleaned output', !/sk-[A-Za-z0-9]{8}/.test(cleanStr));
check('secret-strip: no Bearer token in cleaned output', !/Bearer\s+[A-Za-z0-9]/.test(cleanStr));
check('secret-strip: non-secret field preserved', clean.payload.subject === 'hi');
const arrDirty = stripSecrets({ notes: ['hello', 'paste sk-ABCDEFGH12345678 here'] });
check('secret-strip: secret inside a string-array element removed', arrDirty.stripped.length >= 1 && !JSON.stringify(arrDirty.clean).includes('sk-ABCDEFGH1'), `stripped: ${arrDirty.stripped.join(', ')}`);

// --- routing (SSRF-closed-by-construction) ---
check('intent-valid -> exactly 1 target', resolveRoute('support-triage').targets.length === 1);
check('intent-fanout -> 2 targets (composition)', resolveRoute('feedback-then-grade').targets.length === 2);
check('intent-unknown -> 422 (not routed)', !resolveRoute('delete-everything').ok);
check('intent-missing -> 422 (not routed)', !resolveRoute('').ok);
check('targets are intent names, never URLs', resolveRoute('support-triage').targets.every((t) => !/https?:\/\//i.test(t)));

console.log('');
console.log(`gateway-core self-test: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
