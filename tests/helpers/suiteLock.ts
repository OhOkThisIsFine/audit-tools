// The running-suite registry, shared by vitest's globalSetup and the prebuild
// guard (`scripts/shared/guard-no-suite-running.mjs`).
//
// WHY A REGISTRY AND NOT A MUTEX. The original defect was that two concurrent
// vitest runs corrupted each other (one incident: 61 failures across 6 files in
// areas the diff never touched, all green on a serial re-run). That was a
// FIXTURE collision — both runs shared on-disk scratch dirs. Per-invocation
// roots (tests/helpers/scratch.ts) remove it at the source, so concurrent
// suites are now safe and must NOT be refused: refusing them breaks ordinary
// parallel work, including multi-agent runs, for a hazard that no longer
// exists.
//
// What per-invocation roots CANNOT fix is a `tsc` emit rewriting dist/ while a
// suite is in flight — wrapper tests spawn the real CLIs out of dist/, so they
// fail on files the change never touched. That asymmetry is the whole design:
// suites register themselves, and only a BUILD asks whether any are live.
//
// A lock DIRECTORY with one file per holder, rather than one shared file: each
// holder only ever writes and deletes its own entry, so concurrent registration
// cannot race. Keyed to this checkout (two clones are independent) and kept in
// the OS temp dir, never in the tree — a lock file in the repo would dirty the
// working tree, which is the very defect this cluster exists to remove.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Set on every descendant of a running suite (see global-setup.ts). The prebuild
 * guard exempts these: the dev wrapper auto-rebuilds, and several tests spawn it
 * deliberately, so blocking a suite-owned build breaks the suite outright while
 * protecting nothing — the hazard is an operator or agent rebuilding dist/ from
 * a SEPARATE shell mid-run.
 *
 * ⚠ Known residual, pre-existing and unchanged by this mechanism: a build one
 * test triggers still rewrites dist/ under a parallel worker spawning CLIs from
 * it. Narrowing that needs the wrapper's auto-rebuild to be serialized against
 * the suite, which is a separate change.
 */
export const SUITE_OWNED_BUILD_ENV = "AUDIT_TOOLS_SUITE_OWNED_BUILD";

/** Absolute path of the holder directory for a given checkout root. */
export function suiteLockDir(repoRoot: string): string {
  const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return join(tmpdir(), `audit-tools-vitest-${key}.holders`);
}

/** Whether a pid is still running. A dead holder's entry is stale, not binding. */
export function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is the existence/permission probe — it delivers nothing.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone. EPERM = alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SuiteHolder {
  pid: number;
  startedAt: string;
}

/** Every LIVE registered suite. Stale and unreadable entries are swept. */
export function liveHolders(repoRoot: string): SuiteHolder[] {
  const dir = suiteLockDir(repoRoot);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: SuiteHolder[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let holder: SuiteHolder | null = null;
    try {
      holder = JSON.parse(readFileSync(path, "utf8")) as SuiteHolder;
    } catch {
      // Unreadable, truncated or half-written: not evidence of a live suite.
    }
    if (holder && processAlive(holder.pid)) {
      live.push(holder);
    } else {
      // Sweep: the owner died, or the entry was never valid.
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return live;
}

/** Register this process as a running suite. */
export function registerSuite(repoRoot: string): void {
  const dir = suiteLockDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
}

/** Deregister this process. Only ever removes OUR entry. */
export function unregisterSuite(repoRoot: string): void {
  try {
    rmSync(join(suiteLockDir(repoRoot), `${process.pid}.json`), { force: true });
  } catch {
    /* already gone */
  }
}
