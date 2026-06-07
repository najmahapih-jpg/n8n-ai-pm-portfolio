// test-release-matches-canonical.mjs — offline proof that the committed release JSON matches the canonical JSON.
// (npm run verify:release; also run inside verify:static)
//
// Why this exists: the release snapshot in workflows/releases/ is supposed to reflect what is actually deployed
// (canonical == compile(SDK) == live). If someone bumps the canonical without re-cutting the release snapshot,
// the release silently drifts. This gate catches that. Finding #13 was exactly this scenario.
//
// Volatile-only normalization: same as test-canonical-matches-sdk.mjs —
//   (a) UUID-format values in id / webhookId / versionId / instanceId fields, and any bare UUID string;
//   (b) sticky-note node NAMES carry a random hex suffix (e.g. "Sticky Note e4abdcf1").
// Nothing else is widened. A structural difference after normalization is REAL drift and exits 1.
// No n8n, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const PAIRS = [
  {
    name: 'scheduled-drift-monitor v0.3.0',
    release: join(repoRoot, 'workflows', 'releases', 'scheduled-drift-monitor-v0.3.0.json'),
    canonical: join(repoRoot, 'workflows', 'canonical', 'scheduled-drift-monitor.canonical.json')
  }
];

// --- minimal, provably-volatile-only normalizer (deep) ---
// Mirrors the normalizer in test-canonical-matches-sdk.mjs exactly.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VOLATILE_ID_KEYS = new Set(['id', 'webhookId', 'versionId', 'instanceId']);
const STICKY_NAME_RE = /^Sticky Note [0-9a-f]{6,}$/;

function normalize(value, key) {
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, undefined));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = normalize(value[k], k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (key !== undefined && VOLATILE_ID_KEYS.has(key)) { return '<volatile-id>'; }
    if (UUID_RE.test(value)) { return '<uuid>'; }
    if (key === 'name' && STICKY_NAME_RE.test(value)) { return 'Sticky Note <hex>'; }
    return value;
  }
  return value;
}

function show(obj) { return JSON.stringify(obj, null, 2); }

function firstDiff(aStr, bStr) {
  const a = aStr.split('\n');
  const b = bStr.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) {
      return { line: i + 1, release: a[i] ?? '<eof>', canonical: b[i] ?? '<eof>' };
    }
  }
  return null;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; } else { fail += 1; }
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' -> ' + detail : ''));
}

for (const pair of PAIRS) {
  let release;
  let canonical;
  try {
    release = JSON.parse(readFileSync(pair.release, 'utf8'));
  } catch (e) {
    check(pair.name + ': read release JSON', false, e.message);
    continue;
  }
  try {
    canonical = JSON.parse(readFileSync(pair.canonical, 'utf8'));
  } catch (e) {
    check(pair.name + ': read canonical JSON', false, e.message);
    continue;
  }

  const releaseStr = show(normalize(release, undefined));
  const canonicalStr = show(normalize(canonical, undefined));
  const equal = releaseStr === canonicalStr;
  check(pair.name + ': committed release == canonical (volatile-ids/uuid/sticky-name normalized only)', equal);
  if (!equal) {
    const diff = firstDiff(releaseStr, canonicalStr);
    if (diff) {
      console.log('       REAL DRIFT at normalized line ' + diff.line + ':');
      console.log('         release   : ' + diff.release.trim());
      console.log('         canonical : ' + diff.canonical.trim());
    }
    const releaseCount = release.nodes ? release.nodes.length : 0;
    const canonicalCount = canonical.nodes ? canonical.nodes.length : 0;
    if (releaseCount !== canonicalCount) {
      console.log('       Node count: release=' + releaseCount + ' canonical=' + canonicalCount);
    }
  }
}

console.log('');
console.log('release-matches-canonical self-test: ' + pass + ' passed, ' + fail + ' failed (' + PAIRS.length + ' release/canonical pair(s), OFFLINE, release snapshot must equal deployed reality)');
process.exit(fail > 0 ? 1 : 0);
