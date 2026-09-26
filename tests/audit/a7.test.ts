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
 * GUI-only host validation remains outside this deterministic gate.
 */

import { test, expect } from "vitest";
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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// INSTALL_HOST_ORDER is a plain string[] (the wrapper module carries no JSDoc
// type for it), while INSTALL_HOST_DEFINITIONS is a fixed-key object — narrow
// each iterated key to that object's own key domain, matching the established
// idiom in tests/audit/host-bootstrap-descriptors.test.ts.
type InstallHostKey = keyof typeof INSTALL_HOST_DEFINITIONS;

function readPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
}

// ── (1) drift: verified host set == INSTALL_HOST_ORDER ───────────────────────

test("verify:hosts verifies exactly the hosts in INSTALL_HOST_ORDER (no hand-maintained list)", async () => {
  const report = await verifyHostsIsolated();
  // The reported verified set and the actually-run host set must both equal the
  // single source of truth — adding a host to the table auto-extends the gate.
  expect(report.verified_hosts, "report.verified_hosts must equal INSTALL_HOST_ORDER").toEqual([...INSTALL_HOST_ORDER]);
  expect(report.hosts.map((h) => h.host), "the hosts actually re-verified must equal INSTALL_HOST_ORDER").toEqual([...INSTALL_HOST_ORDER]);
  // Every host in the table has its own verify() handler — the gate would emit a
  // synthetic 'host_handler' error otherwise.
  for (const hostKey of INSTALL_HOST_ORDER) {
    expect(typeof INSTALL_HOST_DEFINITIONS[hostKey as InstallHostKey].verify, `host "${hostKey}" must have a verify() handler`).toBe("function");
  }
});

// ── (2) per-host verify()==ok on a clean deploy ──────────────────────────────

test("a clean deploy passes every host's own verify() handler", async () => {
  const report = await verifyHostsIsolated();
  expect(report.status, `verify:hosts must be ok on a clean deploy; report: ${JSON.stringify(report, null, 2)}`).toBe("ok");
  expect(report.issue_count, "a clean deploy must have zero issues").toBe(0);
  for (const host of report.hosts) {
    expect(host.status, `host "${host.host}" must verify ok; checks: ${JSON.stringify(host.checks)}`).toBe("ok");
    expect(host.checks.length > 0, `host "${host.host}" must run at least one check`).toBeTruthy();
    for (const check of host.checks as Array<{ id: string; status: string; summary?: string }>) {
      expect(check.status, `check "${check.id}" for host "${host.host}" must be ok: ${check.summary ?? ""}`).toBe("ok");
    }
  }
});

// ── (3) temp-$HOME isolation: the real HOME/USERPROFILE is never touched ──────

test("verify:hosts deploys under a temp $HOME and restores the real HOME/USERPROFILE", async () => {
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;

  const report = await verifyHostsIsolated();

  // The redirected HOME is a throwaway temp dir, NOT the operator's real config.
  expect(report.home_dir, "report must record the temp home dir it used").toBeTruthy();
  expect(report.home_dir, "the deploy must use a temp $HOME, never the operator's real HOME").not.toBe(realHome);
  expect(report.repo_root.startsWith(report.home_dir), "the throwaway repo root must live under the temp $HOME").toBeTruthy();

  // The caller's environment is restored exactly on the way out.
  expect(process.env.HOME, "HOME must be restored after the run").toBe(realHome);
  expect(process.env.USERPROFILE, "USERPROFILE must be restored after the run").toBe(realUserProfile);

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
    expect(stats.isDirectory(), "the throwaway repo root must persist when kept").toBeTruthy();
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(report.home_dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── (4) release-gate wiring: verify:hosts ahead of the publish smoke steps
//
// Packet 22 made the release sequence DERIVED from the gate declaration
// (scripts/guard-reach-data.mjs GUARDS → scripts/shared/run-release-gates.mjs),
// so these properties are asserted against the derivation, not a hand-listed
// package.json string. The load-bearing ordering — verify:hosts before the
// packaged smokes, and the linked-install smokes in the release tail — is the
// same; only its home moved.

import { GUARDS } from "../../scripts/guard-reach-data.mjs";
import { releaseGatePhases } from "../../scripts/shared/run-release-gates.mjs";

test("verify:hosts runs ahead of the publish smoke steps", () => {
  const pkg = readPackageJson();
  const verifyChecks = pkg.scripts["verify:checks"];
  const verifyRelease = pkg.scripts["verify:release"];
  expect(verifyChecks, "verify:checks must run through the declared gate catalog").toMatch(
    /\brun-release-gates\.mjs\b/,
  );
  expect(verifyRelease, "verify:release must run the catalog with the release tail").toMatch(
    /\brun-release-gates\.mjs\b/,
  );
  const { default: sequence } = releaseGatePhases();
  // verify:hosts must gate BEFORE the publish smoke steps, not after.
  expect(sequence, "the release sequence must still run the packaged smoke step").toContain(
    "smoke:packaged-audit-code",
  );
  expect(sequence.indexOf("verify:hosts")).toBeLessThan(sequence.indexOf("smoke:packaged-audit-code"));

  // The script itself must exist and point at the real runner.
  expect(pkg.scripts["verify:hosts"], "verify:hosts must invoke the verify-hosts runner script").toBe("node scripts/audit/verify-hosts.mjs");
});

test("verify:release retains both linked-install smoke contracts in the tail", () => {
  const pkg = readPackageJson();
  const verifyRelease = pkg.scripts["verify:release"];
  expect(verifyRelease, "package.json must define a verify:release script").toBeTruthy();
  // The two linked-install smokes are release-tail gates: they run only under
  // verify:release, after the whole default sequence. Their membership is a
  // property of the declaration (release:'tail'), not of the package.json string.
  const { tail } = releaseGatePhases();
  expect(tail, "the release tail must run the linked audit-code smoke").toContain("smoke:linked-audit-code");
  expect(tail, "the release tail must run the linked remediate-code smoke").toContain("smoke:linked-remediate-code");
  // And the catalog marks them tail, never default — a linked smoke folded into
  // verify:checks would run at commit/pre-tag, which the design forbids.
  for (const g of GUARDS) {
    if (g.kind === "gate" && (g.id === "smoke:linked-audit-code" || g.id === "smoke:linked-remediate-code")) {
      expect(g.release, `${g.id} must be a release-tail gate`).toBe("tail");
    }
  }
});
