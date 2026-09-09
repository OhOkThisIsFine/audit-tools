// P62 red-green test — the snapshot helper must extract to a Windows path.
//
// Target: `createIsolatedSnapshot` in
// scripts/shared/dispatch-load-flake-investigation.mjs. It calls
// `spawnSync("tar", ["-xf", archive, ...])` with a bare `tar` and an absolute
// archive path. On Windows the archive path starts `C:\`, and GNU tar parses a
// leading `host:` as a REMOTE MACHINE, so it never reads the file:
//
//     tar: Cannot connect to C: resolve failed
//
// GNU tar resolves first on this machine's PATH (Git Bash `/usr/bin/tar`,
// GNU tar 1.35), ahead of the drive-letter-safe `C:\Windows\System32\tar.exe`.
// On Linux CI the archive path has no drive letter, so the suite is green there
// and red here — the OS-agnostic violation this repo's conventions name.
//
// The test is hermetic: it builds its own tiny archive in a temp directory and
// never touches the repository or a real snapshot.
//
// Run: node --test tar-drive-letter.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The candidate fix sets P62_FIX=1 to select the resolved-argv form, so the
// green half can be proven without landing the patch (leg 3 lands nothing).
function extract(archive, into) {
  if (process.env.P62_FIX === "1") {
    // Candidate: name a tar that accepts a drive-lettered path. On win32 the
    // system tar (bsdtar) does; elsewhere the bare name is already correct.
    const exe =
      process.platform === "win32"
        ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
    return spawnSync(exe, ["-xf", archive, "-C", into], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
  // At HEAD: a bare `tar`, whichever one PATH resolves.
  return spawnSync("tar", ["-xf", archive, "-C", into], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

test("the snapshot helper's tar call extracts an archive at an absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "p62-tar-"));
  writeFileSync(join(dir, "member.txt"), "p62\n");

  // The FIXTURE is built with a tar known to accept a drive-lettered path, so
  // the only thing this test measures is the extraction call under test. Using a
  // bare `tar` here would fail for the very reason being measured, and the test
  // would report a broken fixture instead of the defect.
  const fixtureTar =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const archive = join(dir, "source.tar");
  const packed = spawnSync(fixtureTar, ["-cf", archive, "-C", dir, "member.txt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.equal(packed.status, 0, `fixture archive could not be built: ${packed.stderr}`);

  const into = mkdtempSync(join(tmpdir(), "p62-out-"));
  const unpacked = extract(archive, into);

  assert.equal(
    unpacked.status,
    0,
    "extraction to an absolute path must succeed; a non-zero status here is the " +
      `drive-letter-as-hostname parse: ${String(unpacked.stderr).trim()}`,
  );
  assert.ok(existsSync(join(into, "member.txt")), "the archive member must be extracted");
});
