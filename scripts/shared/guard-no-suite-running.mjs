#!/usr/bin/env node
// prebuild guard: refuse to rewrite dist/ while a vitest suite is in flight.
//
// `npm run build` is the one concurrent mutator that per-invocation fixture
// roots cannot protect against: wrapper tests spawn the real CLIs out of dist/,
// and a tsc emit rewriting those files mid-run fails tests the change never
// touched. One observed incident produced 10 failures across 3 files, all green
// on a serial re-run.
//
// This is the asymmetry the suite registry exists for — concurrent SUITES are
// safe (their fixtures are isolated) and are never refused; only a BUILD asks
// whether any suite is live. Registry written by tests/helpers/global-setup.ts,
// so it covers `npm test` and a bare `npx vitest run` alike.
//
// Deliberately duplicated from tests/helpers/suiteLock.ts rather than imported:
// this runs as `prebuild`, i.e. BEFORE dist/ exists, under plain node with no TS
// loader — the same constraint that makes the .claude/hooks re-declare their
// pattern lists. tests/shared/suite-lock-parity.test.mjs pins the two in sync.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const key = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
const lockDir = join(tmpdir(), `audit-tools-vitest-${key}.holders`);

function processAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Parity probe: lets tests/shared/suite-lock-parity.test.mjs compare this
// script's ACTUAL derivation against the TS helper's, rather than re-deriving
// the formula a third time in the test.
if (process.argv.includes("--print-lock-dir")) {
  process.stdout.write(lockDir);
  process.exit(0);
}

// A build the SUITE itself triggered — the dev wrapper's auto-rebuild, which
// several tests spawn on purpose. Blocking it would break the suite while
// protecting nothing: the hazard this guard exists for is an operator or agent
// rebuilding dist/ from a separate shell mid-run. Kept in sync with
// SUITE_OWNED_BUILD_ENV in tests/helpers/suiteLock.ts by the parity test.
if (process.env.AUDIT_TOOLS_SUITE_OWNED_BUILD) {
  process.exit(0);
}

let names = [];
try {
  names = readdirSync(lockDir);
} catch {
  process.exit(0); // No registry — nothing is running.
}

const live = [];
for (const name of names) {
  const path = join(lockDir, name);
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Unreadable or half-written: not evidence of a live suite.
  }
  if (holder && processAlive(holder.pid)) {
    live.push(holder);
  } else {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort sweep */
    }
  }
}

if (live.length > 0) {
  const who = live.map((h) => `pid ${h.pid} (started ${h.startedAt})`).join(", ");
  process.stderr.write(
    `\nRefusing to build: ${live.length} vitest run(s) for this checkout are in flight — ${who}.\n` +
      `A tsc emit rewrites the dist/ that the suite's wrapper tests are spawning, ` +
      `which fails tests your change never touched.\n` +
      `Wait for the run(s) to finish, or if you are certain they are gone, delete ${lockDir}\n\n`,
  );
  process.exit(1);
}

process.exit(0);
