#!/usr/bin/env node
// Profiled npm-script runner. Runs each named npm script in order, timing each via
// the shared profiler, then persists the ledger + job summary. Fail-fast: a failing
// script stops the chain and exits non-zero, preserving the semantics of the former
// `&&`-chained `verify:checks`.
//
// Usage: node scripts/shared/profile-run.mjs <profile-name> <npm-script>...
//   e.g. node scripts/shared/profile-run.mjs verify-checks check build verify:hosts

import { npmCommand, runProfiledCommands } from "./profile.mjs";

const [profileName, ...scripts] = process.argv.slice(2);

if (!profileName || scripts.length === 0) {
  console.error("Usage: node scripts/shared/profile-run.mjs <profile-name> <npm-script>...");
  process.exit(2);
}

const npm = npmCommand();
const commands = scripts.map((script) => ({
  label: script,
  command: npm,
  args: ["run", "--silent", script],
}));

try {
  await runProfiledCommands(profileName, commands);
} catch (error) {
  console.error(`[profile:${profileName}] ${error.message}`);
  process.exit(1);
}
