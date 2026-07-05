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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Session-activity window: only runs whose newest artifact was touched this recently
// count as "this session" (no exact per-session signal is available to a Stop hook).
const RECENT_MS = 12 * 60 * 60 * 1000;

// The three required friction categories. Hardcoded (a hook can't import the TS
// source without a build) — kept in sync with FRICTION_CATEGORIES in
// src/shared/friction/triage.ts; a drift here only weakens the backstop, never the
// authoritative close gate.
const FRICTION_CATEGORIES = ["ambiguous_direction", "tool_should_decide", "inefficient_feeding"];

/** Newest mtime (ms) among a directory's immediate entries, or 0 if none/unreadable. */
function newestMtimeMs(dir) {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      try {
        const m = statSync(join(dir, name)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    /* unreadable dir */
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
// (frictionCapturePath). A run "happened" in the area when state/artifacts exist; it
// is walked when at least one of its friction records is complete.
const AREAS = [
  { label: "remediate-code", dir: join(root, ".audit-tools", "remediation") },
  { label: "audit-code", dir: join(root, ".audit-tools", "audit") },
];

const now = Date.now();
const needsWalk = [];
for (const area of AREAS) {
  if (!existsSync(area.dir)) continue;
  // A run happened here recently if the area's own artifacts were touched in-window.
  if (now - newestMtimeMs(area.dir) > RECENT_MS) continue;

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
