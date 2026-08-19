#!/usr/bin/env node
//
// Offload-lane reconciliation gate (P36 / solN-1).
//
// The defect class: the session-start lane-liveness leg hardcoded ONE lane URL
// whose probe could not fail (the router's SPA catch-all answers 200 on any
// path), so a dead lane was discovered by dispatching into it — after the lap
// had already planned around delegation. The fix holds the lanes as DECLARED
// DATA (`scripts/shared/offload-lane-data.mjs`) that the guard iterates; this
// gate reconciles the declaration, the same shape as check-guard-reach.mjs:
//   1. registry integrity — unique ids, valid probe shapes, an unprobeable row
//      must state its reason, every row carries an actionable remedy,
//   2. hook wiring — the guard actually imports the registry, and the vacuous
//      probe is pinned OUT forever (no '/health' literal, no hardcoded lane
//      URL in the hook),
//   3. doc coverage — every DOC_LANE_MARKERS entry maps a lane spelling the
//      TRACKED docs use to an existing row (a documented lane cannot be
//      silently unprobed), and a marker no scanned doc contains is rot.
//
// Deliberately NOT scanned: ~/.claude/CLAUDE.md — the true lane authority, but
// untracked and per-machine, and a gate must not ask the local disk. That
// uncovered half is stated as data on the check:offload-lanes guard row in
// scripts/guard-reach-data.mjs.
//
//   node scripts/check-offload-lanes.mjs        # verify
//
// The reconciliation logic is exported as a library (driven by
// tests/shared/offload-lane-probe.test.ts with synthetic registries); the CLI
// body runs only on direct invocation.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOC_LANE_MARKERS, OFFLOAD_LANES, SCANNED_DOCS } from './shared/offload-lane-data.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = 'scripts/shared/offload-lane-data.mjs';
const HOOK_FILE = '.claude/hooks/session-start-guards.mjs';

const LANE_KINDS = new Set(['router', 'mcp-offload', 'peer-cli', 'launcher']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Validate one probe shape; returns problem strings for the row. */
function probeProblems(probe) {
  if (probe === null) return [];
  if (probe.kind === 'http') {
    const problems = [];
    if (!isNonEmptyString(probe.url) || !/^https?:\/\//.test(probe.url)) {
      problems.push('http probe needs an absolute http(s) url');
    }
    if (!(Number.isFinite(probe.timeoutMs) && probe.timeoutMs > 0)) {
      problems.push('http probe needs a positive timeoutMs — an unbounded probe can hang the hook');
    }
    if (!Array.isArray(probe.upStatuses) || probe.upStatuses.length === 0) {
      problems.push('http probe needs non-empty upStatuses — with none declared it can never be up');
    }
    if (probe.requireJsonOn !== undefined && !Array.isArray(probe.requireJsonOn)) {
      problems.push('requireJsonOn must be an array of statuses when present');
    }
    return problems;
  }
  if (probe.kind === 'command') {
    const problems = [];
    if (!isNonEmptyString(probe.command)) problems.push('command probe needs a command');
    if (!Array.isArray(probe.args)) problems.push('command probe needs an args array');
    if (!(Number.isFinite(probe.timeoutMs) && probe.timeoutMs > 0)) {
      problems.push('command probe needs a positive timeoutMs — an unbounded spawn can hang the hook');
    }
    return problems;
  }
  return [`unknown probe kind ${JSON.stringify(probe.kind)} — expected http|command|null`];
}

/**
 * Reconcile the lane registry against the hook source and the tracked docs.
 * Pure — takes the rows, the marker map, the hook's source text and the
 * scanned docs' text keyed by repo path; returns error strings (empty = clean).
 */
export function reconcile({ lanes, markers, hookSource, docTexts }) {
  const errors = [];

  // ── registry integrity ─────────────────────────────────────────────────────
  if (!Array.isArray(lanes) || lanes.length === 0) {
    errors.push(`No lanes declared in ${DATA_FILE} — an empty registry probes nothing and reads as coverage.`);
    return errors;
  }
  const seenIds = new Set();
  const seenOverrides = new Map();
  for (const lane of lanes) {
    const label = `lane "${lane.id ?? '<no id>'}"`;
    if (!isNonEmptyString(lane.id)) errors.push(`A lane row in ${DATA_FILE} has no id.`);
    else if (seenIds.has(lane.id)) errors.push(`Duplicate lane id "${lane.id}" in ${DATA_FILE}.`);
    else seenIds.add(lane.id);
    if (!LANE_KINDS.has(lane.kind)) {
      errors.push(`${label} has unknown kind ${JSON.stringify(lane.kind)} — expected router|mcp-offload|peer-cli|launcher.`);
    }
    for (const field of ['label', 'transport', 'remedy']) {
      if (!isNonEmptyString(lane[field])) {
        errors.push(`${label} is missing ${field} — a down lane must be nameable and actionable.`);
      }
    }
    if (lane.probe === null) {
      if (!isNonEmptyString(lane.unprobeableReason)) {
        errors.push(`${label} declares no probe and no unprobeableReason — unprobeable is a STATEMENT, never silence.`);
      }
    } else {
      if (lane.unprobeableReason !== undefined) {
        errors.push(`${label} carries both a probe and an unprobeableReason — contradictory; keep one.`);
      }
      for (const p of probeProblems(lane.probe)) errors.push(`${label}: ${p}`);
    }
    if (lane.envOverride !== undefined) {
      if (!isNonEmptyString(lane.envOverride)) {
        errors.push(`${label} has an empty envOverride.`);
      } else if (seenOverrides.has(lane.envOverride)) {
        errors.push(
          `envOverride "${lane.envOverride}" is claimed by both "${seenOverrides.get(lane.envOverride)}" and ` +
            `"${lane.id}" — one test override would redirect two lanes.`,
        );
      } else {
        seenOverrides.set(lane.envOverride, lane.id);
      }
    }
  }

  // ── hook wiring: the guard iterates THIS registry, vacuous probe pinned out ─
  if (!hookSource.includes('offload-lane-data.mjs')) {
    errors.push(`${HOOK_FILE} does not reference ${DATA_FILE} — the lane-liveness leg is not iterating the registry.`);
  }
  if (hookSource.includes('/health')) {
    errors.push(
      `${HOOK_FILE} contains a '/health' literal — that probe is vacuous (the SPA catch-all answers 200 on any ` +
        `path) and was retired by P36; probe data lives only in ${DATA_FILE}.`,
    );
  }
  if (/https?:\/\//.test(hookSource)) {
    errors.push(
      `${HOOK_FILE} contains a hardcoded URL — lane endpoints live only in ${DATA_FILE}, where the reconciler ` +
        `and the docs can see them.`,
    );
  }

  // ── doc coverage, both directions over TRACKED docs only ───────────────────
  const docEntries = Object.entries(docTexts);
  const seenMarkers = new Set();
  for (const { marker, laneId } of markers) {
    if (!isNonEmptyString(marker)) {
      errors.push(`A DOC_LANE_MARKERS entry in ${DATA_FILE} has an empty marker.`);
      continue;
    }
    if (seenMarkers.has(marker)) errors.push(`Duplicate doc marker "${marker}" in ${DATA_FILE}.`);
    seenMarkers.add(marker);
    if (!seenIds.has(laneId)) {
      errors.push(
        `Doc marker "${marker}" cites lane "${laneId}", which has no row in ${DATA_FILE} — a documented lane ` +
          `cannot be silently unprobed; restore the row or retire the marker WITH its doc text.`,
      );
    }
    if (!docEntries.some(([, text]) => text.includes(marker))) {
      errors.push(
        `Doc marker "${marker}" (lane "${laneId}") appears in no scanned doc ` +
          `(${docEntries.map(([p]) => p).join(', ')}) — registry rot; update or drop the marker.`,
      );
    }
  }

  return errors;
}

function main() {
  const hookSource = readFileSync(join(repoRoot, HOOK_FILE), 'utf8');
  const docTexts = {};
  for (const doc of SCANNED_DOCS) docTexts[doc] = readFileSync(join(repoRoot, doc), 'utf8');

  const errors = reconcile({ lanes: OFFLOAD_LANES, markers: DOC_LANE_MARKERS, hookSource, docTexts });

  if (errors.length) {
    console.error('✗ offload-lane check failed:\n\n' + errors.join('\n\n') + '\n');
    process.exit(1);
  }
  const probed = OFFLOAD_LANES.filter((l) => l.probe !== null).length;
  console.log(
    `✓ offload-lanes: ${OFFLOAD_LANES.length} lanes declared (${probed} probed, ` +
      `${OFFLOAD_LANES.length - probed} unprobeable with reasons stated); hook iterates the registry; ` +
      `${DOC_LANE_MARKERS.length} doc markers reconciled over ${SCANNED_DOCS.length} tracked docs`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
