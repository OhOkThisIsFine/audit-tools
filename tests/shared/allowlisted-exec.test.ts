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
import { test, expect, vi } from "vitest";
import { execFileSyncHidden as execFileSync, spawnSyncHidden } from "../helpers/spawn.mjs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    ["rg", "--no-config", "needle"],
    ["ripgrep", "--no-config", "needle"],
    // Canonical allowed form cited by CP-NODE-4's allowlist-shape obligation.
    ["rg", "-n", "-e", "foo"],
    ["ripgrep", "x"],
    ["findstr", "/s", "/i", "x", "."],
    ["madge", "--circular", "src"],
    ["madge", "--json", "--orphans", "src"],
    ["ast-grep", "run", "-p", "pattern", "-l", "ts"],
    ["sg", "-p", "x", "--json"],
    ["grep.exe", "x"],
  ]) {
    expect(isAllowedAnchorCommand(cmd), `should allow ${cmd.join(" ")}`).toBe(true);
  }
  const baselines = [
    ["git", "grep", "-n", "-e", "needle", "--", "src"],
    ["git", "log", "-n", "5", "--oneline", "HEAD", "--", "src"],
    ["git", "diff", "--stat", "HEAD"],
    ["git", "show", "HEAD:file.ts"],
    ["git", "ls-files", "-z", "--", "src"],
    ["git", "cat-file", "-p", "HEAD"],
    ["git", "blame", "-L", "1,5", "--", "file.ts"],
    ["git", "rev-parse", "--verify", "HEAD"],
    ["git", "status", "--short", "--", "src"],
  ];
  expect(new Set(baselines.map(command => command[1]))).toEqual(GIT_READONLY_SUBCOMMANDS);
  for (const command of baselines) {
    expect(isAllowedAnchorCommand(command), `should allow ${command.join(" ")}`).toBe(true);
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

test("a path-qualified executable is refused even when its basename is allowlisted", async () => {
  const r = await runAllowlistedReadOnlyCommand(
    ["definitely-not-a-real-directory-xyz/grep", "-n", "x"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(r.refused).toBe(true);
  expect(r.exit_code).toBe(null);
  expect(r.spawn_error).toBeUndefined();
});

for (const command of [
  ["./untrusted/git", "status"],
  ["/usr/bin/grep", "needle"],
  ["C:\\tools\\git.exe", "status"],
  ["C:git.exe", "status"],
  ["\\\\server\\share\\git.exe", "status"],
  ["..\\git.cmd", "status"],
  ["git", "-ccore.fsmonitor=./payload", "status"],
  ["git", "log", "-o/tmp/report"],
  ["git", "status", "--future-unsafe-option"],
  ["git", "log", "--max-count"],
  ["git", "log", "--max-count=not-a-number"],
  ["git", "log", "--show-signature"],
  ["git", "diff", "--textconv"],
  ["git", "cat-file", "--filters", "HEAD:file.ts"],
  ["git", "log", "--output", "/tmp/report"],
  ["git", "log", "--output=/tmp/report"],
  ["git", "log", "--oneline=payload"],
  ["git", "log", "--max-count", "--all"],
  ["git", "log", "--format=%G?"],
  ["git", "show", "--pretty=payload"],
  ["git", "status", "--untracked-files=invalid"],
  ["git", "status", "--untracked-files", "no"],
  ["git", "cat-file", "HEAD"],
  ["git", "cat-file", "-p", "-t", "HEAD"],
  ["git", "cat-file", "-p", "HEAD", "extra"],
  ["git", "rev-parse", "--", "--verify"],
  ["git", "grep", "-O", "payload"],
  ["git", "log", "-np"],
  [" git", "status"],
  ["git\u0000", "status"],
]) {
  test(`public inspection admission refuses ${JSON.stringify(command)}`, () => {
    expect(isAllowedAnchorCommand(command)).toBe(false);
  });
}

test("Git grammar consumes attached and separated values and treats -- paths literally", () => {
  for (const command of [
    ["git", "log", "-n5", "HEAD"],
    ["git", "log", "--max-count=5"],
    ["git", "diff", "-U3", "--", "--output=literal-path"],
    ["git", "status", "--untracked-files=no"],
    ["git", "status", "--", "-ccore.fsmonitor=literal-path"],
    ["git", "--no-pager", "log", "--oneline"],
    ["git", "grep", "-eneedle", "--", "src"],
  ]) expect(isAllowedAnchorCommand(command), command.join(" ")).toBe(true);
});

test("sparse argv is refused without throwing", () => {
  const command = ["git", "log"];
  command.length = 3;
  expect(isAllowedAnchorCommand(command)).toBe(false);
});

const nativeRgProbe = spawnSyncHidden("rg", ["--version"], { encoding: "utf8", timeout: 3000 });
test.skipIf(nativeRgProbe.error !== undefined || nativeRgProbe.status !== 0)(
  "available native ripgrep ignores an ambient preprocessor config (inert positive control)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "inspection-rg-config-"));
    const marker = join(root, "marker");
    const input = join(root, "input.cjs");
    const config = join(root, "ripgrep-config");
    writeFileSync(input, 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "called"); console.log("needle");\n');
    writeFileSync(config, "--pre\n" + process.execPath + "\n");
    try {
      execFileSync("rg", ["needle", input], { cwd: root, env: { ...process.env, RIPGREP_CONFIG_PATH: config }, encoding: "utf8", timeout: 5000 });
      expect(readFileSync(marker, "utf8")).toBe("called");
      rmSync(marker);
      vi.stubEnv("RIPGREP_CONFIG_PATH", config);
      const result = await runAllowlistedReadOnlyCommand(["rg", "needle", input], root, 5000);
      expect(result.exit_code, result.output).toBe(0);
      expect(result.output).toContain("needle");
      expect(existsSync(marker)).toBe(false);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  },
);

test("real Git config helpers stay disabled while inspection returns useful output", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspection-git-config-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = (...args: string[]): string => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: repo, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const marker = join(root, "marker");
  const helper = join(root, "inert-helper");
  const quoted = (value: string): string => "'" + value.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'";
  writeFileSync(helper, "#!/bin/sh\nprintf called >> " + quoted(marker) + "\nprintf 'converted fixture\\n'\n");
  chmodSync(helper, 0o755);
  const helperCommand = quoted(helper);
  try {
    git("init", "-q");
    git("config", "user.name", "Inspection Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "file.txt"), "original fixture\n");
    git("add", "file.txt");
    git("-c", "commit.gpgSign=false", "commit", "-qm", "fixture");
    writeFileSync(join(repo, "file.txt"), "changed fixture\n");

    git("config", "diff.external", helperCommand);
    git("diff"); // Positive control: this harmless fixture helper is reachable.
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const external = await runAllowlistedReadOnlyCommand(["git", "diff"], repo, 5000);
    expect(external).toMatchObject({ exit_code: 0, timed_out: false });
    expect(external.output).toContain("changed fixture");
    expect(existsSync(marker)).toBe(false);
    git("config", "--unset", "diff.external");

    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=fixture\n");
    git("config", "diff.fixture.textconv", helperCommand);
    git("diff");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    for (const command of [["git", "diff"], ["git", "log", "-p", "-n1"], ["git", "show", "-p"], ["git", "blame", "--", "file.txt"]]) {
      const result = await runAllowlistedReadOnlyCommand(command, repo, 5000);
      expect(result.exit_code, result.output).toBe(0);
      expect(existsSync(marker)).toBe(false);
    }

    git("config", "core.fsmonitor", helperCommand);
    execFileSync("git", ["status", "--short"], { cwd: repo, env, stdio: "pipe" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const status = await runAllowlistedReadOnlyCommand(["git", "status", "--short", "--untracked-files=no"], repo, 5000);
    expect(status.exit_code, status.output).toBe(0);
    expect(status.output).toContain("file.txt");
    expect(existsSync(marker)).toBe(false);

    git("config", "gpg.program", helper.replace(/\\/g, "/"));
    const tree = git("rev-parse", "HEAD^{tree}").trim();
    const commit = "tree " + tree + "\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n inert-fixture\n -----END PGP SIGNATURE-----\n\nsigned-looking fixture\n";
    const object = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, env, input: commit, encoding: "utf8" }).trim();
    git("update-ref", "refs/heads/fixture-signed", object);
    git("config", "format.pretty", "format:%G?");
    git("config", "log.showSignature", "true");
    git("log", "-n1", object);
    expect(readFileSync(marker, "utf8")).toContain("called");
    rmSync(marker);
    const log = await runAllowlistedReadOnlyCommand(["git", "log", "-n1", object], repo, 5000);
    expect(log.exit_code, log.output).toBe(0);
    expect(log.output).toContain("signed-looking fixture");
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

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
