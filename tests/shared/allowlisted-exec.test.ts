/**
 * allowlisted-exec.test.ts — the default-deny per-executable flag allowlist
 * (CRIT ARC-a06a3945) and the shared read-only runner (drift-plan E2).
 *
 * The CRIT bug was that the old guard validated only command[0] and waved every
 * argument through, so an allowlisted executable carrying a code-exec/file-write
 * flag (`rg --pre <cmd>`, `ast-grep --rewrite`, non-read-only git, …) ran. These
 * tests feed adversarial argv and assert the WHOLE command is refused, plus the
 * legitimate read-only commands still pass, plus the runner spawns argv-only.
 */
import { test, expect } from "vitest";
import {
  isAllowedAnchorCommand,
  runAllowlistedReadOnlyCommand,
  ANCHOR_ALLOWLIST,
  GIT_READONLY_SUBCOMMANDS,
  ALLOWLISTED_EXEC_TIMEOUT_MS,
} from "audit-tools/shared";

test("isAllowedAnchorCommand allows legitimate read-only inspection commands", () => {
  for (const cmd of [
    ["grep", "-r", "-n", "needle", "."],
    ["grep", "--include", "*.ts", "x", "src"],
    ["rg", "-i", "--json", "pattern", "src"],
    ["rg", "-t", "js", "x"],
    // Canonical allowed form cited by CP-NODE-4's allowlist-shape obligation.
    ["rg", "-n", "-e", "foo"],
    ["ripgrep", "x"],
    ["findstr", "/s", "/i", "x", "."],
    ["madge", "--circular", "src"],
    ["madge", "--json", "--orphans", "src"],
    ["ast-grep", "run", "-p", "pattern", "-l", "ts"],
    ["sg", "-p", "x", "--json"],
    ["/usr/bin/grep", "x"],
    ["grep.exe", "x"],
    ["C:\\\\tools\\\\rg.cmd", "x"],
  ]) {
    expect(isAllowedAnchorCommand(cmd), `should allow ${cmd.join(" ")}`).toBe(true);
  }
  for (const sub of GIT_READONLY_SUBCOMMANDS) {
    expect(isAllowedAnchorCommand(["git", sub, "HEAD"]), `should allow git ${sub}`).toBe(true);
  }
});

test("CRIT: adversarial arguments on an ALLOWED executable are refused (arg validation, not just command[0])", () => {
  const adversarial = [
    // ripgrep: preprocessor exec / decompression — the headline CVE-class flags.
    ["rg", "--pre", "sh", "pattern", "."],
    ["rg", "--pre=sh", "pattern"],
    ["rg", "--pre-glob", "*", "--pre", "evil", "x"],
    ["rg", "--search-zip", "x"],
    ["rg", "-z", "x"],
    ["ripgrep", "--pre", "cmd", "x"],
    // ast-grep: rewrite / update / interactive all WRITE files.
    ["ast-grep", "--rewrite", "evil", "-p", "x"],
    ["ast-grep", "-r", "x"],
    ["ast-grep", "--update-all", "run"],
    ["ast-grep", "-U"],
    ["ast-grep", "-i"],
    ["sg", "--rewrite", "x"],
    // madge: writes an output file.
    ["madge", "--image", "out.png", "src"],
    ["madge", "-i", "out.svg", "src"],
    ["madge", "--dot", "src"],
    // grep: an unknown/unsafe flag must be refused under default-deny.
    ["grep", "--pre", "x"],
    ["grep", "-f", "/etc/passwd", "x"],
    ["grep", "--some-future-write-flag", "x"],
  ];
  for (const cmd of adversarial) {
    expect(isAllowedAnchorCommand(cmd), `MUST refuse adversarial argv: ${cmd.join(" ")}`).toBe(false);
  }
});

test("CRIT: git is refused for non-read-only subcommands and for write/reconfigure options", () => {
  const refused = [
    // mutating subcommands
    ["git", "push"],
    ["git", "reset", "--hard"],
    ["git", "checkout", "."],
    ["git", "clean", "-fdx"],
    ["git", "commit", "-m", "x"],
    ["git", "apply", "patch"],
    // read-only subcommand BUT a write/reconfigure option anywhere → refused
    ["git", "log", "--output=/tmp/evil"],
    ["git", "log", "-o", "file"],
    ["git", "log", "-o", "/tmp/evil"],
    // Canonical fixture cited by CP-NODE-4's allowlist-shape obligation.
    ["git", "-c", "x=y", "log"],
    ["git", "-c", "core.pager=evil", "log"],
    ["git", "--exec-path=/tmp", "status"],
    ["git", "--config-env", "X=Y", "diff"],
    // no subcommand at all
    ["git"],
    ["git", "--no-pager"],
  ];
  for (const cmd of refused) {
    expect(isAllowedAnchorCommand(cmd), `MUST refuse git: ${cmd.join(" ")}`).toBe(false);
  }
});

test("non-allowlisted executables are refused regardless of args", () => {
  for (const cmd of [
    ["node", "-e", "1"],
    ["npm", "run", "x"],
    ["npx", "y"],
    ["rm", "-rf", "/"],
    ["del", "x"],
    ["eslint", "--fix", "."],
    ["tsc"],
    ["bash", "-c", "x"],
    ["sh", "-c", "x"],
    ["python", "-c", "1"],
    [""],
    [],
  ]) {
    expect(isAllowedAnchorCommand(cmd), `MUST refuse non-allowlisted: ${cmd.join(" ") || "(empty)"}`).toBe(false);
  }
});

test("ANCHOR_ALLOWLIST exposes the inspection executables incl. git", () => {
  for (const exe of ["grep", "rg", "ripgrep", "findstr", "madge", "ast-grep", "sg", "git"]) {
    expect(ANCHOR_ALLOWLIST.has(exe), `${exe} should be in ANCHOR_ALLOWLIST`).toBeTruthy();
  }
  // It must NOT advertise anything that executes arbitrary code.
  for (const exe of ["node", "npm", "bash", "sh", "python"]) {
    expect(!ANCHOR_ALLOWLIST.has(exe), `${exe} must NOT be in ANCHOR_ALLOWLIST`).toBeTruthy();
  }
});

test("runAllowlistedReadOnlyCommand runs an allowlisted command argv-only and reports exit code", async () => {
  // git rev-parse is allowlisted and read-only; run it in this package dir.
  const r = await runAllowlistedReadOnlyCommand(
    ["git", "rev-parse", "--is-inside-work-tree"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(r.timed_out).toBe(false);
  expect(r.spawn_error).toBe(undefined);
  expect(r.exit_code, `expected exit 0, got ${r.exit_code}: ${r.output}`).toBe(0);
  expect(r.output.trim()).toMatch(/true/);
});

test("runAllowlistedReadOnlyCommand reports a spawn error for an ALLOWLISTED executable whose path does not resolve, without throwing", async () => {
  // The internal gate (invariants[2]) now refuses a non-allowlisted executable
  // NAME before ever reaching spawn (see allowlisted-exec-runner-internals.test.ts
  // for that refusal path) — so a genuine "spawn failed" outcome now requires an
  // executable whose BASENAME is allowlisted ("grep") but whose resolved path
  // does not exist, still reaching a real ENOENT from the OS.
  const r = await runAllowlistedReadOnlyCommand(
    ["definitely-not-a-real-directory-xyz/grep", "-n", "x"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(r.refused, "an allowlisted basename must not be refused by the internal gate").not.toBe(true);
  expect(r.exit_code).toBe(null);
  expect(typeof r.spawn_error === "string" && r.spawn_error.length > 0).toBeTruthy();
});

// ── internal gate idempotence (invariants[2]) ───────────────────────────────
// runAllowlistedReadOnlyCommand now enforces isAllowedAnchorCommand on itself,
// unconditionally, before spawning. A caller-side pre-check becomes a
// redundant, OPTIONAL fast path —
// double-gating must be OBSERVATIONALLY IDENTICAL to single-gating for an
// already-allowed command: the internal gate must never additionally refuse,
// alter timing semantics, or change the outcome shape for a command the
// caller already confirmed.
test("internal gate idempotence: a pre-gated allowed command behaves identically with and without the caller-side check", async () => {
  const allowedCommand = ["git", "rev-parse", "--is-inside-work-tree"];

  // Caller-side pre-check, THEN run (the caller-gated pattern).
  expect(isAllowedAnchorCommand(allowedCommand)).toBe(true);
  const withCallerCheck = await runAllowlistedReadOnlyCommand(
    allowedCommand,
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );

  // Direct call, no caller-side pre-check at all — the internal gate alone.
  const withoutCallerCheck = await runAllowlistedReadOnlyCommand(
    allowedCommand,
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );

  // Neither call was refused, both actually ran the command, and both agree
  // on the outcome shape (exit_code / timed_out / refused / output presence).
  expect(withCallerCheck.refused).not.toBe(true);
  expect(withoutCallerCheck.refused).not.toBe(true);
  expect(withCallerCheck.timed_out).toBe(false);
  expect(withoutCallerCheck.timed_out).toBe(false);
  expect(withCallerCheck.spawn_error).toBe(undefined);
  expect(withoutCallerCheck.spawn_error).toBe(undefined);
  expect(withCallerCheck.exit_code).toBe(withoutCallerCheck.exit_code);
  expect(withCallerCheck.output.trim()).toBe(withoutCallerCheck.output.trim());
});
