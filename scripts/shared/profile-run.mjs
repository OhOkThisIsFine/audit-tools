#!/usr/bin/env node
// sites-pinned: tests/shared/profile-run-cli.test.ts
// Profiled npm-script runner. Runs each named npm script in order, timing each via
// the shared profiler, then persists the ledger + job summary. Stops on failed
// prerequisites; the final, independent checks smokes together own no shared output.
//
// Usage: node scripts/shared/profile-run.mjs <profile-name> <npm-script>...
//   e.g. node scripts/shared/profile-run.mjs verify-checks check build verify:hosts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogCommands } from "./verify-steps.mjs";
import { npmCommand, runProfiledCommands } from "./profile.mjs";

const [profileName, ...scripts] = process.argv.slice(2);

if (!profileName || scripts.length === 0) {
  console.error("Usage: node scripts/shared/profile-run.mjs <profile-name> <npm-script>...");
  process.exit(2);
}

const npm = npmCommand();
const mode = scripts[0]?.match(/^--catalog=(checks|release)$/)?.[1];
// A checks invocation owns one fresh tarball unless its caller (the publish
// workflow) already owns the directory. The guarded prepack build supplies the
// same dist to later checks, while both smokes consume the exact same verified pack.
let ownedPackDir;
try {
  if (mode === "checks" && !process.env.AUDIT_TOOLS_RELEASE_PACK_DIR) {
    ownedPackDir = mkdtempSync(join(tmpdir(), "audit-tools-checks-pack-"));
    process.env.AUDIT_TOOLS_RELEASE_PACK_DIR = ownedPackDir;
  }
  const commands = mode ? catalogCommands(mode, undefined, npm, {
    freshReleasePack: Boolean(process.env.AUDIT_TOOLS_RELEASE_PACK_DIR),
  }) : scripts.map((script) => ({
    label: script,
    command: npm,
    args: ["run", "--silent", script],
  }));
  // Each smoke owns a separate install/repo/state (or only reads the built
  // gate), and the two packaged smokes use the same already-verified tarball.
  // Restrict concurrency to this known terminal set, not arbitrary catalog additions.
  const smokeTail = ["smoke:packaged-audit-code", "smoke:packaged-remediate-code", "smoke:remediate-gate"];
  const parallelTail = mode === "checks" && smokeTail.every((label, i) =>
    commands[commands.length - smokeTail.length + i]?.label === label)
    ? smokeTail.length : 0;
  await runProfiledCommands(profileName, commands, { parallelTail });
} catch (error) {
  console.error(`[profile:${profileName}] ${/** @type {any} */ (error).message}`);
  process.exitCode = 1;
} finally {
  // Never remove a caller-owned pack: publish uploads it after the gate.
  if (ownedPackDir) {
    try {
      rmSync(ownedPackDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[profile:${profileName}] could not remove temporary checks pack: ${/** @type {Error} */ (error).message}`);
    }
  }
}
