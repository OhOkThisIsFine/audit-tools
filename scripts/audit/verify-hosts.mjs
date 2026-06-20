#!/usr/bin/env node
// A-7 multi-host validation gate. Deploys every host's assets into an ISOLATED
// throwaway repo root under a redirected $HOME (never the operator's real
// config), then re-runs each host's verify() handler from the SAME
// INSTALL_HOST_DEFINITIONS table that drives the deploy. Adding a host to the
// table auto-extends this gate — the verified host set is derived from
// INSTALL_HOST_ORDER, not a hand-maintained list.
//
// Wired into `verify:release` so a drifted, missing, or unparseable host asset
// fails the gate before publish (same class of bug as the A6 requiredPackagedPaths
// miss). GUI-only checks CI cannot reach (a real /audit-code dispatch inside
// Antigravity / OpenCode) live in docs/host-validation.md.
import {
  INSTALL_HOST_ORDER,
  verifyHostsIsolated,
} from '../../audit-code-wrapper-install-hosts.mjs';

const verbose = process.env.AUDIT_CODE_VERBOSE === '1';

const report = await verifyHostsIsolated();

if (verbose || report.status !== 'ok') {
  console.log(JSON.stringify(report, null, 2));
}

for (const host of report.hosts) {
  const failed = host.checks.filter((check) => check.status === 'error');
  if (failed.length === 0) {
    console.log(`verify:hosts: ${host.host} ok (${host.checks.length} checks)`);
    continue;
  }
  console.error(`verify:hosts: ${host.host} FAILED`);
  for (const check of failed) {
    console.error(`  - ${check.id}: ${check.summary}`);
  }
}

if (report.status !== 'ok') {
  console.error(
    `verify:hosts: ${report.issue_count} issue(s) across ${INSTALL_HOST_ORDER.length} host(s).`,
  );
  process.exit(1);
}

console.log(
  `verify:hosts: all ${report.verified_hosts.length} host(s) verified — ${report.verified_hosts.join(', ')}.`,
);
process.exit(0);
