import { expect, test } from "vitest";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { jscpdCandidate, osvScannerCandidate } from "../../src/shared/analyzers/candidates.js";

// Dogfood 2026-11-04: the snapshot tree lives under `~/.audit-code/snapshots/<id>/tree`.
// jscpd globbed its absolute positional path, which matched zero files on a
// Windows backslash path (and on `(` `[` `{` `!` anywhere above the repo).
// osv-scanner 2.4.0 walks from the FILESYSTEM root and applied a home-directory
// `.gitignore` listing `.audit-code/`, so `--recursive <root>` found nothing
// (exit 128); `--no-ignore` instead scanned every ignored dependency/build dir.
test("jscpd scans `.` (the engine spawns it with cwd = root), never a globbed absolute path", () => {
  const argv = jscpdCandidate.buildArgv(["npx", "-y", "jscpd@4.3.0"], "C:\\Users\\u (x)\\.audit-code\\snapshots\\x\\tree");
  expect(argv[argv.length - 1]).toBe(".");
  expect(argv.some((arg) => arg.includes(".audit-code"))).toBe(false);
});

function write(root: string, path: string, content = "{}\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test("osv-scanner is given exactly the repository's own lockfiles, never its ignored dependency or build dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "osv-inputs-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, ".gitignore", "node_modules/\nbuild/\n.venv/\n");
    write(root, "package-lock.json");
    write(root, "packages/web/yarn.lock", "\n");
    write(root, "services/api/dev-requirements.txt", "requests==2.0.0\n");
    write(root, "src/App.deps.json");
    write(root, "README.md", "# r\n");
    // Ignored by the repository's own rules: dependency, build and venv output.
    write(root, "node_modules/dep/package-lock.json");
    write(root, "build/package-lock.json");
    write(root, ".venv/lib/poetry.lock", "\n");
    // Tracked, then deleted: listed by git, absent from the tree osv would read.
    write(root, "old/Cargo.lock", "\n");
    execFileSync("git", ["add", "old/Cargo.lock"], { cwd: root });
    rmSync(join(root, "old"), { recursive: true });

    const discovered = await osvScannerCandidate.discoverInputs!(root);
    expect(discovered).toEqual({
      ok: true,
      paths: [
        "package-lock.json",
        "packages/web/yarn.lock",
        "services/api/dev-requirements.txt",
        "src/App.deps.json",
      ],
    });
    const inputs = discovered.ok ? discovered.paths : [];
    expect(osvScannerCandidate.buildArgv(["osv"], root, { inputs })).toEqual([
      "osv", "scan", "--format", "json", "--allow-no-lockfiles",
      "-L", "package-lock.json",
      "-L", "packages/web/yarn.lock",
      "-L", "services/api/dev-requirements.txt",
      "-L", "src/App.deps.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
