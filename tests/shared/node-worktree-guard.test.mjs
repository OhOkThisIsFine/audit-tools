import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  AUDIT_TOOLS_CALLER_CWD_ENV,
  nodeWorktreeAncestor,
  assertCliCommandAllowedFromCwd,
  assertNotNodeWorktreeCwd,
} from "../../src/shared/index.ts";
import { stripClaudeCodeEnv } from "../../src/shared/tooling/exec.ts";

function fixtureRepo() {
  return mkdtempSync(join(tmpdir(), "nwg-"));
}

describe("nodeWorktreeAncestor — tool-worktree path detection", () => {
  it("detects a remediate implement worktree root and returns it", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "remediate-CP-1-run1");
    expect(nodeWorktreeAncestor(wt)).toBe(wt);
  });

  it("detects an audit review snapshot (any worktree name) from a nested cwd", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "review-20260722T005925355Z");
    expect(nodeWorktreeAncestor(join(wt, "src", "shared"))).toBe(wt);
  });

  it("returns null outside worktrees: repo root, plain .audit-tools drift, bare worktrees dir", () => {
    const repo = fixtureRepo();
    expect(nodeWorktreeAncestor(repo)).toBeNull();
    // .audit-tools drift WITHOUT a worktree segment stays climb territory
    // (climbOutOfAuditTools's original pathology), never a refusal.
    expect(nodeWorktreeAncestor(join(repo, ".audit-tools", "remediation"))).toBeNull();
    expect(nodeWorktreeAncestor(join(repo, ".audit-tools", "worktrees"))).toBeNull();
  });

  it("is not fooled by a repo directory NAMED audit-tools (no dot)", () => {
    expect(nodeWorktreeAncestor(join("C:", "Code", "audit-tools", "worktrees", "x"))).toBeNull();
  });

  it("detects a re-cased path (win32 is case-insensitive; refusing more is safe)", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".AUDIT-TOOLS", "Worktrees", "remediate-b1-r1");
    expect(nodeWorktreeAncestor(wt)).toBe(wt);
  });
});

describe("assertCliCommandAllowedFromCwd — deny-by-default CLI guard", () => {
  const workerSafe = new Set(["submit-packet", "validate"]);
  const wtOf = (repo) => join(repo, ".audit-tools", "worktrees", "remediate-b1-r1");

  it("refuses a driver lifecycle command from a node-worktree cwd, naming the worktree", () => {
    const wt = wtOf(fixtureRepo());
    expect(() =>
      assertCliCommandAllowedFromCwd({
        cliName: "remediate-code",
        commandName: "next-step",
        workerSafeCommands: workerSafe,
        cwd: wt,
      }),
    ).toThrow(/refusing to run `remediate-code next-step`.*node worktree/s);
  });

  it("refuses an UNKNOWN (future) command from a worktree cwd — fail-closed default", () => {
    expect(() =>
      assertCliCommandAllowedFromCwd({
        cliName: "audit-code",
        commandName: "some-future-command",
        workerSafeCommands: workerSafe,
        cwd: wtOf(fixtureRepo()),
      }),
    ).toThrow(/refusing to run/);
  });

  it("allows a worker-safe command from the same worktree cwd", () => {
    expect(() =>
      assertCliCommandAllowedFromCwd({
        cliName: "audit-code",
        commandName: "submit-packet",
        workerSafeCommands: workerSafe,
        cwd: wtOf(fixtureRepo()),
      }),
    ).not.toThrow();
  });

  it("allows a driver command from a normal cwd", () => {
    expect(() =>
      assertCliCommandAllowedFromCwd({
        cliName: "remediate-code",
        commandName: "next-step",
        workerSafeCommands: workerSafe,
        cwd: fixtureRepo(),
      }),
    ).not.toThrow();
  });

  it("refuses on a RAW --root that points into a worktree even from a normal cwd", () => {
    const repo = fixtureRepo();
    expect(() =>
      assertCliCommandAllowedFromCwd({
        cliName: "remediate-code",
        commandName: "next-step",
        workerSafeCommands: workerSafe,
        cwd: repo,
        rawRoot: wtOf(repo),
      }),
    ).toThrow(/refusing to run/);
  });
});

describe("assertNotNodeWorktreeCwd — writer-side defense-in-depth", () => {
  it("refuses a session write from a worktree cwd and allows a normal cwd", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "remediate-b1-r1");
    expect(() => assertNotNodeWorktreeCwd("a rolling-session write", wt)).toThrow(
      /refusing to run a rolling-session write/,
    );
    expect(() => assertNotNodeWorktreeCwd("a rolling-session write", repo)).not.toThrow();
  });
});

describe("caller-cwd env propagation pins (wrapper cannot import the TS module)", () => {
  it("the audit wrapper stamps the exact env var the guard reads", () => {
    const wrapper = readFileSync(
      new URL("../../wrapper/audit-code-wrapper-lib.mjs", import.meta.url),
      "utf8",
    );
    expect(wrapper).toContain(`${AUDIT_TOOLS_CALLER_CWD_ENV}: process.cwd()`);
  });

  it("stripClaudeCodeEnv scrubs the stamp so provider-spawned workers never inherit it", () => {
    const out = stripClaudeCodeEnv({
      [AUDIT_TOOLS_CALLER_CWD_ENV]: "C:/somewhere",
      KEEP_ME: "yes",
    });
    expect(out[AUDIT_TOOLS_CALLER_CWD_ENV]).toBeUndefined();
    expect(out.KEEP_ME).toBe("yes");
  });
});

describe("CLI wiring — spawned dist backends refuse from node-worktree context", () => {
  // Spawn-based: each child owns its env/cwd, so no process-global mutation
  // leaks into parallel test files. Requires a built dist (npm test builds).
  const remediateDist = fileURLToPath(new URL("../../dist/remediate/index.js", import.meta.url));
  const auditDist = fileURLToPath(new URL("../../dist/audit/index.js", import.meta.url));

  it("remediate-code next-step refuses when its cwd is inside a node worktree", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "remediate-b1-r1");
    mkdirSync(wt, { recursive: true });
    // next-step is the observed stray invocation from the live clobber.
    const run = spawnSyncHidden(process.execPath, [remediateDist, "next-step"], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env },
      windowsHide: true,
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stderr}\n${run.stdout}`).toMatch(/refusing to run `remediate-code next-step`/);
  });

  it("audit-code refuses a driver command when the wrapper-stamped caller cwd is a worktree", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "review-run1");
    mkdirSync(wt, { recursive: true });
    const run = spawnSyncHidden(process.execPath, [auditDist, "status"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, [AUDIT_TOOLS_CALLER_CWD_ENV]: wt },
      windowsHide: true,
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stderr}\n${run.stdout}`).toMatch(/refusing to run `audit-code status`/);
  });

  it("audit-code worker-safe submit-packet is NOT refused from a worktree context", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "review-run1");
    mkdirSync(wt, { recursive: true });
    const run = spawnSyncHidden(process.execPath, [auditDist, "submit-packet"], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, [AUDIT_TOOLS_CALLER_CWD_ENV]: wt },
      input: "",
      windowsHide: true,
    });
    // It will fail on missing flags/payload — but never with the guard refusal.
    expect(`${run.stderr}\n${run.stdout}`).not.toMatch(/refusing to run/);
  });

  it("StateStore writers refuse from a worktree cwd (non-CLI invocation shape)", () => {
    const repo = fixtureRepo();
    const wt = join(repo, ".audit-tools", "worktrees", "remediate-b1-r1");
    const artifacts = join(repo, ".audit-tools", "remediation");
    mkdirSync(wt, { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    const storeUrl = new URL("../../dist/remediate/state/store.js", import.meta.url).href;
    const script = `
      const { StateStore } = await import(${JSON.stringify(storeUrl)});
      const store = new StateStore(${JSON.stringify(artifacts)});
      await store.init();
      try {
        await store.saveState({ status: "pending" });
        console.error("UNEXPECTED: write succeeded");
        process.exit(0);
      } catch (err) {
        console.error(String(err));
        process.exit(3);
      }
    `;
    const run = spawnSyncHidden(process.execPath, ["--input-type=module", "-e", script], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env },
      windowsHide: true,
    });
    expect(run.status).toBe(3);
    expect(run.stderr).toMatch(/refusing to run a remediation state\.json write/);
  });
});
