#!/usr/bin/env node
// The agent lane receives a disposable archive of the exact observed tree,
// never the live checkout or its git metadata. Its writes are therefore local
// to a snapshot that this worker deletes after the report is captured.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveExecArgv } from "../../dist/shared/tooling/exec.js";
import { openDispatchLane } from "./mcp-dispatch-lane.mjs";

/**
 * Spawn a logical argv with the platform resolution applied.
 *
 * `tar` is why this exists (P62): the archive path below is absolute, so on
 * Windows it begins `C:\`, and a bare `tar` resolved through PATH is GNU tar
 * wherever a Git Bash sits ahead of `System32` — which died with
 * `tar: Cannot connect to C: resolve failed`, because GNU tar reads a leading
 * `host:` as a REMOTE MACHINE. `resolveExecArgv` is the repo's one answer to
 * "which executable is the right one on this platform"; a raw name here is the
 * defect, not a style choice.
 *
 * Imported from `dist/` deliberately, and this is the ONLY such import in
 * scripts/: this module runs as a detached child of the vitest gate, i.e. only
 * ever inside a built tree, so the compiled twin is always present. Modules
 * that can run pre-build (`.claude/hooks/`, `prebuild`) must not copy this line.
 */
function spawnResolved(argv, options) {
  const [command, ...args] = resolveExecArgv(argv);
  return spawnSync(command, args, options);
}

export function createIsolatedSnapshot(repoRoot, tree) {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tree)) throw new Error(`invalid tree id: ${tree}`);
  const snapshot = mkdtempSync(join(tmpdir(), "audit-tools-load-flake-"));
  const archive = join(snapshot, "source.tar");
  try {
    const packed = spawnResolved(["git", "archive", "--format=tar", `--output=${archive}`, tree], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true,
    });
    if (packed.status !== 0) throw new Error(`git archive failed (${packed.status}): ${packed.stderr}`);
    const unpacked = spawnResolved(["tar", "-xf", archive, "-C", snapshot], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true,
    });
    if (unpacked.status !== 0) throw new Error(`snapshot extraction failed (${unpacked.status}): ${unpacked.stderr}`);
    rmSync(archive, { force: true });
    return snapshot;
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

function writeFailure(reportPath, error) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const typed = /** @type {any} */ (error);
  writeFileSync(reportPath, `# Investigation failed\n\n${typed?.stack ?? error}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const [requestPath, reportPath] = argv;
  if (!requestPath || !reportPath) return 2;
  let snapshot = null;
  let lane = null;
  try {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    snapshot = createIsolatedSnapshot(request.repoRoot, request.tree);
    lane = openDispatchLane({ size: 1, cwd: snapshot });
    const result = await lane.dispatch(
      [
        `Investigate a repeated full-suite-only failure in ${request.file}.`,
        `It failed under load and passed alone on ${request.count} distinct source trees (${request.environment}).`,
        "Your cwd is a disposable no-git snapshot of the exact observed tree. Inspect only this snapshot; all writes are discarded.",
        "Identify a concrete hermeticity, contention, timeout, or shared-state mechanism and propose the smallest TEST repair.",
        "Return evidence, patch shape, and focused verification commands; name any missing measurement.",
      ].join("\n"),
      { mode: "agent", cwd: snapshot, timeoutMs: 30 * 60 * 1000 },
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `# Repeated load-flake investigation: ${request.file}\n\n` +
        `- environment: ${request.environment}\n- observations: ${request.count}\n` +
        `- lane: ${result.lane}\n- status: ${result.status}\n\n${result.raw || result.error || "No answer returned."}\n`,
      "utf8",
    );
    return 0;
  } catch (error) {
    writeFailure(reportPath, error);
    return 1;
  } finally {
    if (lane) await lane.close();
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
