/**
 * A-7 multi-host install/integration validation gate.
 *
 * The `verify:hosts` script (`scripts/audit/verify-hosts.mjs` →
 * `verifyHostsIsolated()`) deploys every host surface into an ISOLATED throwaway
 * repo root under a redirected `$HOME`/`USERPROFILE`, then re-runs each host's
 * `verify()` handler from the SAME `INSTALL_HOST_DEFINITIONS` table the
 * postinstall deploy uses. Adding a host to that table auto-extends both the
 * deploy and this gate, so the verified host set can never drift from the
 * deployed set by hand.
 *
 * Coverage here (the acceptance criteria from docs/remaining-specs.md §A7):
 *  1. drift: the verified host set equals INSTALL_HOST_ORDER (single source).
 *  2. per-host verify()==ok: a clean deploy passes every host's own handler.
 *  3. temp-$HOME isolation: the operator's real HOME/USERPROFILE is never
 *     touched, and is restored afterwards.
 *  4. release-gate wiring: `verify:release` invokes `verify:hosts` ahead of the
 *     publish smoke steps.
 *
 * Plus a GATED Codex headless live-dispatch e2e (skips cleanly unless
 * RUN_CODEX_E2E=1), mirroring the NIM e2e gate — the things CI cannot reach
 * (Antigravity / OpenCode GUI dispatch) live in spec/host-validation.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALL_HOST_ORDER,
  INSTALL_HOST_DEFINITIONS,
  verifyHostsIsolated,
} from "../../wrapper/audit-code-wrapper-install-hosts.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning } from "./helpers/fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

function readPackageJson() {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

// ── (1) drift: verified host set == INSTALL_HOST_ORDER ───────────────────────

test("verify:hosts verifies exactly the hosts in INSTALL_HOST_ORDER (no hand-maintained list)", async () => {
  const report = await verifyHostsIsolated();
  // The reported verified set and the actually-run host set must both equal the
  // single source of truth — adding a host to the table auto-extends the gate.
  assert.deepEqual(
    report.verified_hosts,
    [...INSTALL_HOST_ORDER],
    "report.verified_hosts must equal INSTALL_HOST_ORDER",
  );
  assert.deepEqual(
    report.hosts.map((h) => h.host),
    [...INSTALL_HOST_ORDER],
    "the hosts actually re-verified must equal INSTALL_HOST_ORDER",
  );
  // Every host in the table has its own verify() handler — the gate would emit a
  // synthetic 'host_handler' error otherwise.
  for (const hostKey of INSTALL_HOST_ORDER) {
    assert.equal(
      typeof INSTALL_HOST_DEFINITIONS[hostKey].verify,
      "function",
      `host "${hostKey}" must have a verify() handler`,
    );
  }
});

// ── (2) per-host verify()==ok on a clean deploy ──────────────────────────────

test("a clean deploy passes every host's own verify() handler", async () => {
  const report = await verifyHostsIsolated();
  assert.equal(
    report.status,
    "ok",
    `verify:hosts must be ok on a clean deploy; report: ${JSON.stringify(report, null, 2)}`,
  );
  assert.equal(report.issue_count, 0, "a clean deploy must have zero issues");
  for (const host of report.hosts) {
    assert.equal(
      host.status,
      "ok",
      `host "${host.host}" must verify ok; checks: ${JSON.stringify(host.checks)}`,
    );
    assert.ok(host.checks.length > 0, `host "${host.host}" must run at least one check`);
    for (const check of host.checks) {
      assert.equal(
        check.status,
        "ok",
        `check "${check.id}" for host "${host.host}" must be ok: ${check.summary ?? ""}`,
      );
    }
  }
});

// ── (3) temp-$HOME isolation: the real HOME/USERPROFILE is never touched ──────

test("verify:hosts deploys under a temp $HOME and restores the real HOME/USERPROFILE", async () => {
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;

  const report = await verifyHostsIsolated();

  // The redirected HOME is a throwaway temp dir, NOT the operator's real config.
  assert.ok(report.home_dir, "report must record the temp home dir it used");
  assert.notEqual(
    report.home_dir,
    realHome,
    "the deploy must use a temp $HOME, never the operator's real HOME",
  );
  assert.ok(
    report.repo_root.startsWith(report.home_dir),
    "the throwaway repo root must live under the temp $HOME",
  );

  // The caller's environment is restored exactly on the way out.
  assert.equal(process.env.HOME, realHome, "HOME must be restored after the run");
  assert.equal(
    process.env.USERPROFILE,
    realUserProfile,
    "USERPROFILE must be restored after the run",
  );

  // By default the throwaway tree is cleaned up — nothing leaks to disk.
  await assert.rejects(
    stat(report.home_dir),
    "the temp $HOME must be removed after the run (keepArtifacts defaults to false)",
  );
});

test("verify:hosts can keep its artifacts for inspection (keepArtifacts)", async () => {
  const report = await verifyHostsIsolated({ keepArtifacts: true });
  try {
    const stats = await stat(report.repo_root);
    assert.ok(stats.isDirectory(), "the throwaway repo root must persist when kept");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(report.home_dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── (4) release-gate wiring: verify:release invokes verify:hosts ahead of publish

test("verify:release invokes verify:hosts ahead of the publish smoke steps", () => {
  const pkg = readPackageJson();
  const verifyRelease = pkg.scripts["verify:release"];
  assert.ok(verifyRelease, "package.json must define a verify:release script");
  assert.match(
    verifyRelease,
    /\bnpm run verify:hosts\b/,
    "verify:release must invoke verify:hosts",
  );
  // It must gate BEFORE the publish smoke steps, not after.
  const hostsIdx = verifyRelease.indexOf("verify:hosts");
  const smokeIdx = verifyRelease.indexOf("smoke:packaged-audit-code");
  assert.ok(smokeIdx >= 0, "verify:release must still run the packaged smoke step");
  assert.ok(
    hostsIdx < smokeIdx,
    "verify:hosts must run ahead of the publish smoke steps",
  );

  // The script itself must exist and point at the real runner.
  assert.equal(
    pkg.scripts["verify:hosts"],
    "node scripts/audit/verify-hosts.mjs",
    "verify:hosts must invoke the verify-hosts runner script",
  );
});

// ── Codex headless live-dispatch e2e — GATED (skips cleanly without a live env)

const RUN_CODEX_E2E = process.env.RUN_CODEX_E2E === "1";

// Codex is a headless CLI, so unlike Antigravity / OpenCode (GUI, checklist-only)
// its live `/audit-code` dispatch CAN be automated. It hits a real Codex backend,
// so it must never run in the normal suite / CI — gate it like the NIM e2e
// (`RUN_NIM_E2E=1`). Run it with:
//   RUN_CODEX_E2E=1 node --import tsx/esm --test tests/audit/a7.test.mjs
test(
  "Codex headless: a live /audit-code dispatch round-trips one bounded audit step",
  {
    skip: RUN_CODEX_E2E
      ? false
      : "set RUN_CODEX_E2E=1 to run the live Codex headless dispatch e2e",
  },
  async () => {
    // Two-part gate. (1) Deploy the Codex host surface into an isolated temp $HOME
    // and assert it verifies ok — proof the production codex surface installs.
    // (2) Drive a REAL headless Codex dispatch through the production rolling
    // engine over a fixture advanced to planning, and assert one bounded audit
    // step round-trips (a review result lands). The bare host-surface repo has no
    // audit state, so the dispatch runs against a planning-ready fixture — exactly
    // like the NIM rolling-audit e2e, but with the codex CLI as the review worker.
    const report = await verifyHostsIsolated({ keepArtifacts: true });
    try {
      const codex = report.hosts.find((h) => h.host === "codex");
      assert.ok(codex, "the Codex host surface must deploy");
      assert.equal(codex.status, "ok", "the Codex host surface must verify ok before live dispatch");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(report.home_dir, { recursive: true, force: true }).catch(() => {});
    }

    const { runCodexHeadlessAuditDispatch } = await import(
      "../../src/audit/cli/nextStepCommand.ts"
    );
    const { writeCoreArtifacts } = await import("../../src/audit/io/artifacts.ts");
    await withTempDir("codex-headless-audit-e2e-", async (root) => {
      // Advance the deterministic chain (intake → … → planning) and persist the
      // bundle so the next obligation is the host-delegation dispatch
      // (audit_tasks_completed) — the only point the rolling engine takes over.
      await writeFixtureRepo(root);
      const { planning } = await advanceFixtureToPlanning(root);
      const artifactsDir = join(root, ".audit-tools", "audit");
      await writeCoreArtifacts(artifactsDir, planning.updated_bundle, { prune: true });

      const outcome = await runCodexHeadlessAuditDispatch({ root });
      assert.ok(
        outcome && outcome.dispatched,
        "a live Codex headless dispatch must round-trip one bounded audit step",
      );
    });
  },
);
