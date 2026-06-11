// Test-ReleaseMatchesCanonical.mjs — offline gate: current release snapshot == canonical workflow.
// (npm run verify:release; also invoked inside verify:static.)
//
// WHY THIS EXISTS
// ---------------
// The release file (workflows/releases/product-feedback-intelligence-v<version>.json) is a
// deployable snapshot of the canonical workflow at the time of a version cut. Without a gate it
// can silently lag canonical — e.g. the v0.2.0 release was cut before the additive
// executeWorkflowTrigger ("Called By Gateway") was added to canonical, so the release had 28
// nodes while the deployed reality had 29. This script catches that class of drift.
//
// STRICTNESS CHOICE
// -----------------
// We normalise only PROVABLY VOLATILE data before comparing:
//   • node-level `id` (UUID assigned by n8n at import time — differs per environment)
//   • node-level `webhookId` (assigned by n8n per deployment)
//   • top-level `id` (internal canonical logical key, absent from release envelope)
//   • sticky-note name hex suffix: n8n appends an 8-char hex fragment to "Sticky Note" names
//     (e.g. "Sticky Note 8d132d6f") that is meaningless to content; the release may carry the
//     bare sequential name ("Sticky Note 1") from an earlier export.  We strip the suffix/number
//     so both sides normalise to the same base name for the name-set check.
//
// We do NOT normalise:
//   • node type, typeVersion, position, or parameters — structural content that must match.
//   • connections or settings — structural content that must match.
//
// The gate asserts:
//   1. Node COUNT matches (catches an extra or missing node).
//   2. Node NAME SET matches (after hex-suffix normalisation — catches renamed or added nodes).
//   3. Full structural equality of each shared node (after stripping volatile id/webhookId).
//   4. connections block equality.
//   5. settings block equality.
//
// This is deliberately strict enough to catch "snapshot lags canonical" while not being brittle
// to volatile UUIDs that change legitimately on every import/redeploy.
//
// WHICH RELEASE FILE
// ------------------
// The script auto-discovers the highest-versioned release file in workflows/releases/ by sorting
// the versioned filenames lexicographically (semver-like, zero-padded components sort correctly
// for the minor-version range in use here).  This matches the convention Invoke-StaticValidation.ps1
// uses (it hard-codes the current release path) without requiring a separate version config field.
// When you cut a new release, drop the new snapshot in workflows/releases/ and this gate
// automatically targets it.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

// Discover the highest-versioned release file.
const releasesDir = join(repoRoot, 'workflows', 'releases');
const releaseFiles = readdirSync(releasesDir)
  .filter(f => /^product-feedback-intelligence-v\d+\.\d+\.\d+\.json$/.test(f))
  .sort()  // lexicographic sort works for vMAJOR.MINOR.PATCH with consistent zero-padding
  .reverse();

if (releaseFiles.length === 0) {
  console.error('No versioned release files found in workflows/releases/');
  process.exit(1);
}

const currentReleaseFile = releaseFiles[0];
const version = currentReleaseFile.replace('product-feedback-intelligence-v', '').replace('.json', '');
const releasePath = join(releasesDir, currentReleaseFile);
const canonicalPath = join(repoRoot, 'workflows', 'canonical', 'product-feedback-intelligence.canonical.json');

const rel = JSON.parse(readFileSync(releasePath, 'utf8'));
const can = JSON.parse(readFileSync(canonicalPath, 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('[PASS] ' + label + (detail ? ' -> ' + detail : ''));
  } else {
    fail += 1;
    const msg = '[FAIL] ' + label + (detail ? ' -> ' + detail : '');
    console.log(msg);
    failures.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Normalise a node: strip volatile fields, normalise sticky-note name.
// ---------------------------------------------------------------------------
function normalizeStickyName(name) {
  // "Sticky Note 8d132d6f" or "Sticky Note 8d132d6f-c604-4948-..." -> "Sticky Note"
  // "Sticky Note 1" (sequential) -> "Sticky Note"
  return name
    .replace(/^(Sticky Note)\s+[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/, '$1')
    .replace(/^(Sticky Note)\s+[0-9a-f]{6,8}$/, '$1')
    .replace(/^(Sticky Note)\s+\d+$/, '$1');
}

function normalizeNode(node) {
  const copy = { ...node };
  delete copy.id;
  delete copy.webhookId;
  copy.name = normalizeStickyName(node.name);
  return copy;
}

// ---------------------------------------------------------------------------
// 1. Node count
// ---------------------------------------------------------------------------
check(
  'node count: release (' + rel.nodes.length + ') == canonical (' + can.nodes.length + ')',
  rel.nodes.length === can.nodes.length,
  'release=' + rel.nodes.length + ' canonical=' + can.nodes.length
);

// ---------------------------------------------------------------------------
// 2. Node name set (after normalisation)
// ---------------------------------------------------------------------------
const relNames = new Set(rel.nodes.map(n => normalizeStickyName(n.name)));
const canNames = new Set(can.nodes.map(n => normalizeStickyName(n.name)));

const onlyInRel = [...relNames].filter(n => !canNames.has(n));
const onlyInCan = [...canNames].filter(n => !relNames.has(n));

check(
  'node name set: no nodes only in release',
  onlyInRel.length === 0,
  onlyInRel.length ? 'extra in release: ' + onlyInRel.join(', ') : 'ok'
);
check(
  'node name set: no nodes only in canonical',
  onlyInCan.length === 0,
  onlyInCan.length ? 'missing from release: ' + onlyInCan.join(', ') : 'ok'
);

// ---------------------------------------------------------------------------
// 3. Per-node structural equality (nodes present in both after normalisation)
// ---------------------------------------------------------------------------
const canByNormName = {};
for (const n of can.nodes) {
  canByNormName[normalizeStickyName(n.name)] = normalizeNode(n);
}

for (const relNode of rel.nodes) {
  const normName = normalizeStickyName(relNode.name);
  const relNorm = normalizeNode(relNode);
  const canNorm = canByNormName[normName];
  if (!canNorm) continue; // already flagged in name-set check

  check(
    'node structural match: ' + relNode.name,
    JSON.stringify(relNorm) === JSON.stringify(canNorm),
    JSON.stringify(relNorm) !== JSON.stringify(canNorm)
      ? 'release=' + JSON.stringify(relNorm) + ' canonical=' + JSON.stringify(canNorm)
      : 'ok'
  );
}

// ---------------------------------------------------------------------------
// 4. Connections equality
// ---------------------------------------------------------------------------
check(
  'connections block matches canonical',
  JSON.stringify(rel.connections) === JSON.stringify(can.connections),
  JSON.stringify(rel.connections) !== JSON.stringify(can.connections) ? 'diverge' : 'ok'
);

// ---------------------------------------------------------------------------
// 5. Settings equality
// ---------------------------------------------------------------------------
check(
  'settings block matches canonical',
  JSON.stringify(rel.settings) === JSON.stringify(can.settings),
  JSON.stringify(rel.settings) !== JSON.stringify(can.settings) ? 'diverge' : 'ok'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(
  'release-matches-canonical: ' + pass + ' passed, ' + fail + ' failed' +
  ' (v' + version + ' release vs canonical, volatile-normalised)'
);

if (fail > 0) {
  console.log('');
  console.log('FAILURES:');
  for (const f of failures) { console.log('  ' + f); }
}

process.exit(fail > 0 ? 1 : 0);
