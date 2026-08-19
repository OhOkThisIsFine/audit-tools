#!/usr/bin/env node
// Stop gate: a session-level BACKSTOP for the friction close-out walk.
//
// The end-of-run close gate (src/shared/friction/triage.ts) blocks a remediate/
// audit run from CLOSING until every friction category is covered. But a run that
// BYPASSES close — the 2026-07-04 verify-runner recovery assembled the branch by
// hand and never hit the close gate — leaves its friction unlogged. This hook is
// the backstop: when the session ends, if a RECENT remediate/audit run on disk has
// no COMPLETE friction walk (all three FRICTION_CATEGORIES covered by an
// open_observations[] entry or an explicit category_attestations[] "none"), block
// the stop once and point the agent at the walk.
//
// Safety (a Stop hook is high-blast-radius, so it fails OPEN everywhere):
//  - honors the AUDIT_TOOLS_NO_FRICTION_STOP_GATE kill-switch;
//  - blocks at most ONCE per stop cycle (exits 0 when stop_hook_active) so it can
//    never wedge a session in a block loop;
//  - only considers runs whose newest artifact was touched within RECENT_MS (a
//    session proxy) so a long-abandoned run doesn't nag forever;
//  - swallows every fs/parse error → exit 0 (a broken backstop must never trap).
//
// Exit 0 = allow stop, exit 2 = block (stderr is fed back to the agent).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionHasLiveBackgroundWork } from "../../scripts/shared/liveSessionWork.mjs";
import { readSessionRegistry } from "../../scripts/shared/sessionRegistry.mjs";

// Fail open on the kill-switch or a re-entrant stop (already blocked once).
if (process.env.AUDIT_TOOLS_NO_FRICTION_STOP_GATE) process.exit(0);

let payload = {};
try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  payload = raw ? JSON.parse(raw) : {};
} catch {
  process.exit(0); // unparseable payload — never wedge the session
}
// Claude sets stop_hook_active when it is ALREADY continuing from a prior stop-hook
// block: we blocked once, gave the agent its chance, so let this stop through.
if (payload?.stop_hook_active) process.exit(0);

// A stop while background tasks are live (or session crons are scheduled) is a
// turn boundary the harness resumes, not the session ending — the friction walk
// is owed at the REAL close, and forcing it mid-wait records a partial lap.
if (sessionHasLiveBackgroundWork(payload)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Build 1 (P23): a child session's stop must not be recruited into the friction
// walk. An unregistered session while the registry is ARMED is a dispatched
// child — its stop is a deliverable hand-back, so exit silently before the disk
// scan. No session_id in the payload → legacy behavior (fire as today); any
// registry fault fails open inside the predicate.
if (readSessionRegistry(root, payload?.session_id).isUnregisteredChild) process.exit(0);

// Session-activity window: only runs whose newest artifact was touched this
// recently count as "this session". The payload's session_id names WHO is
// stopping (the registry skip above keys on it), but which RUN on disk belongs
// to this session still has no exact signal — the mtime window stays the proxy.
const RECENT_MS = 12 * 60 * 60 * 1000;

// The three required friction categories. Hardcoded (a hook can't import the TS
// source without a build) — kept in lockstep with FRICTION_CATEGORIES, single-sourced
// in src/shared/friction/frictionRecord.ts (re-exported through triage.ts). A drift
// here only weakens the backstop, never the authoritative close gate, but the parity
// is pinned by a test (tests/shared/friction-derived-observations.test.mjs) that
// asserts this literal equals the source array. Tool-derived pre-populated
// observations land in the SAME open_observations[] shape this gate reads, so a
// category the backend already saw re-work in counts as covered here for free.
const FRICTION_CATEGORIES = ["ambiguous_direction", "tool_should_decide", "inefficient_feeding"];

/**
 * Newest mtime (ms) among an area's genuine run markers, or 0 if none exist. Keying
 * on a substantive run artifact (not mere dir existence) is what distinguishes a real
 * run from a trivial stub — a bare `session-config.json` (a 3-byte provider handshake a
 * test or `ensure` can drop) is NOT a run and must never trip the gate.
 */
function newestRunMarkerMs(dir, markers) {
  let newest = 0;
  for (const marker of markers) {
    try {
      const m = statSync(join(dir, marker)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* marker absent */
    }
  }
  return newest;
}

/** Does a friction record cover every category (observation or attestation)? */
function recordIsComplete(recordPath) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    return false;
  }
  const covered = new Set();
  for (const o of rec?.open_observations ?? []) if (o?.category) covered.add(o.category);
  for (const a of rec?.category_attestations ?? []) if (a?.category) covered.add(a.category);
  return FRICTION_CATEGORIES.every((c) => covered.has(c));
}

// Each orchestrator area writes its friction records under <area>/friction/<run>.json
// (frictionCapturePath). A run "happened" in the area when a genuine run MARKER exists
// (not mere dir existence — the repo dogfoods `.audit-tools/`, so a test/ensure stub
// must not trip the gate); it is walked when ≥1 of its friction records is complete.
const AREAS = [
  {
    label: "remediate-code",
    dir: join(root, ".audit-tools", "remediation"),
    markers: ["state.json"],
  },
  {
    label: "audit-code",
    dir: join(root, ".audit-tools", "audit"),
    // A real audit reaches at least a manifest / task ledger / dispatch / findings
    // artifact; a bare session-config.json alone is not a run. A bare steps/ dir is
    // NOT a marker either: terminal promotion deletes the artifacts dir, archives
    // the friction record with the promoted deliverables, and the completed-step
    // render recreates steps/ — treating that post-completion state as a run made
    // every later stop block on a record the tool had already archived.
    markers: ["repo_manifest.json", "audit_tasks.json", "active-dispatch.json", "audit-findings.json"],
  },
];

const now = Date.now();
const needsWalk = [];

// In-flight window: if a session is actively churning on a run, a concurrent
// bystander session must not block it (the driving session will handle its own
// friction walk after churn stops).
const IN_FLIGHT_MS = 2 * 60 * 1000; // 2 minutes

for (const area of AREAS) {
  // A run happened here recently only if a genuine run marker exists and was touched
  // in-window (the session proxy) — a stub or a long-abandoned run never blocks.
  const markerMs = newestRunMarkerMs(area.dir, area.markers);
  if (markerMs === 0 || now - markerMs > RECENT_MS) continue;

  // Skip this area if its run is visibly in flight (current-step.json was touched
  // recently). A concurrent session's active work must not be blocked by the
  // bystander; the driving session owes the friction walk at its own close.
  const currentStepPath = join(area.dir, "steps", "current-step.json");
  try {
    const stepMs = statSync(currentStepPath).mtimeMs;
    if (now - stepMs < IN_FLIGHT_MS) continue; // in flight, skip
  } catch {
    /* file does not exist or is unreadable — not in flight */
  }

  const frictionDir = join(area.dir, "friction");
  let records = [];
  try {
    records = readdirSync(frictionDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => join(frictionDir, n));
  } catch {
    records = []; // no friction dir → no walk started
  }
  const anyComplete = records.some((p) => recordIsComplete(p));
  if (!anyComplete) needsWalk.push(area.label);
}

if (needsWalk.length === 0) process.exit(0);

console.error(
  `friction stop-gate: a recent ${needsWalk.join(" + ")} run in this session has no completed ` +
    `friction close-out walk. Before ending, account for all three categories ` +
    `(${FRICTION_CATEGORIES.join(", ")}) on the run's friction record — append an ` +
    `open_observations[] entry per real friction, or an explicit category_attestations[] ` +
    `"none" for a clean category (the same walk the run's close step enforces). ` +
    `Then stop again. (Set AUDIT_TOOLS_NO_FRICTION_STOP_GATE=1 to bypass this backstop.)`,
);
process.exit(2);
