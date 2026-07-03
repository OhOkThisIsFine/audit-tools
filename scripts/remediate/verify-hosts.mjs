#!/usr/bin/env node
// Multi-host validation gate for remediate-code (mirror of scripts/audit/verify-hosts.mjs).
// Deploys every host's assets into an ISOLATED throwaway repo root under a
// redirected $HOME, then re-runs each host's verify() handler from the SAME
// INSTALL_HOST_DEFINITIONS table that drives the deploy. Adding a host to the
// table auto-extends this gate — the verified host set is derived from
// INSTALL_HOST_ORDER, not a hand-maintained list.
//
// Wired into `verify:release` (as verify:remediate-hosts) so a drifted, missing,
// or unparseable host asset fails the gate before publish.
import {
  INSTALL_HOST_ORDER,
  verifyHostsIsolated,
} from '../../wrapper/remediate-code-wrapper-install-hosts.mjs';

const verbose = process.env.REMEDIATE_CODE_VERBOSE === '1';

const report = await verifyHostsIsolated();

if (verbose || report.status !== 'ok') {
  console.log(JSON.stringify(report, null, 2));
}

for (const host of report.hosts) {
  const failed = host.checks.filter((check) => check.status === 'error');
  if (failed.length === 0) {
    console.log(`verify:remediate-hosts: ${host.host} ok (${host.checks.length} checks)`);
    continue;
  }
  console.error(`verify:remediate-hosts: ${host.host} FAILED`);
  for (const check of failed) {
    console.error(`  - ${check.id}: ${check.summary}`);
  }
}

if (report.status !== 'ok') {
  console.error(
    `verify:remediate-hosts: ${report.issue_count} issue(s) across ${INSTALL_HOST_ORDER.length} host(s).`,
  );
  process.exit(1);
}

console.log(
  `verify:remediate-hosts: all ${report.verified_hosts.length} host(s) verified — ${report.verified_hosts.join(', ')}.`,
);
process.exit(0);
