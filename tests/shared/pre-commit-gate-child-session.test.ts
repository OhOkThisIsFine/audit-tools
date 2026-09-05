// Pre-commit gate: child-session commit/push refusal + narrow push detection
// (Build 1 / P23). A session with no record in `.claude/hooks/.state/sessions/`
// while the registry is ARMED is a child agent sharing the checkout — its
// `git commit` / `git push` is refused; the per-dispatch allow token
// (AUDIT_TOOLS_AGENT_GIT, via the shared bypassEnabled mechanic) admits the
// command into the NORMAL gate rather than around it. `git push` is detected
// ONLY for this refusal and must never start the commit machinery.
//
// Fixture + rationale in pre-commit-gate-harness.ts (shared across the
// pre-commit-gate-*.test.ts family). Every case gets a fresh repo: arming the
// registry is permanent for a root.
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSessionRecord } from "../../scripts/shared/sessionRegistry.mjs";
import { g as gIn, initGateRepo, runCommitGate, runGate as runGateIn } from "./pre-commit-gate-harness.js";

let repo: string;
const g = (...args: string[]) => gIn(repo, ...args);
// P53: the COMMIT half of the refusal runs at git's boundary (commit-gate.mjs),
// keyed on CLAUDE_CODE_SESSION_ID in the hook's environment; the PUSH half,
// which has no git hook of ours, stays in the tool-boundary hook.
const runGate = (command?: string, opts?: { sessionId?: string; env?: NodeJS.ProcessEnv }) =>
  runGateIn(repo, command, opts);
const runCommit = (opts?: { sessionId?: string; env?: NodeJS.ProcessEnv }) => runCommitGate(repo, opts);

beforeEach(() => {
  repo = initGateRepo();
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

// Arm the fixture repo's registry — the lib's own writer, so the fixture can
// never drift from the frozen record shape. Zero ids still arms (throwaway id).
function armRegistry(...ids: string[]): void {
  for (const id of ids.length === 0 ? ["resident-owner"] : ids) {
    writeSessionRecord(repo, {
      version: 1,
      session_id: id,
      registered_at: new Date().toISOString(),
      source: "test",
      baseline: [],
    });
  }
}

// Stage a BAD sentinel so the fixture's `npm run check` fails — the probe for
// "did the commit machinery actually run".
function stageBadSentinel(): void {
  writeFileSync(join(repo, "sentinel.txt"), "BAD\n");
  g("add", "sentinel.txt");
}

describe("pre-commit gate: child-session refusal (Build 1 / P23)", () => {
  test("C-1: refuses an unregistered session's commit, naming the mechanism but NO bypass route (P27)", () => {
    armRegistry();
    const r = runCommit({ sessionId: "child-1" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/child session/i);
    expect(r.stderr).toContain(".claude/hooks/.state/sessions/");
    // P27 + amendment B2: the refusal must not teach its own bypass — no token
    // name, no lib/CLI name, no doc pointer, no recovery flag.
    expect(r.stderr).not.toContain("AUDIT_TOOLS_AGENT_GIT");
    expect(r.stderr).not.toContain("sessionRegistry.mjs");
    expect(r.stderr).not.toContain("durable-traps");
    expect(r.stderr).not.toContain("--register");
  });

  test("C-2: refuses an unregistered session's push", () => {
    armRegistry();
    const r = runGate("git push", { sessionId: "child-1" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/child session/i);
  });

  test("C-3: the inline token admits the commit past the tool-boundary hook", () => {
    // The inline prefix is parsed here; by the time git runs the hook it is a
    // real environment variable (C-5 is that half).
    armRegistry();
    const r = runGate("AUDIT_TOOLS_AGENT_GIT=1 git commit -m x", { sessionId: "child-1" });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(/child session/i);
  });

  test("C-4: the token admits the commit into the NORMAL gate, not around it — BAD still blocks", () => {
    armRegistry();
    stageBadSentinel();
    const r = runCommit({ sessionId: "child-1", env: { AUDIT_TOOLS_AGENT_GIT: "1" } });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("`npm run check` FAILED");
    expect(r.stderr).not.toMatch(/child session/i);
  });

  test("C-5: the environment form of the token is what git's hook honors", () => {
    armRegistry();
    const r = runCommit({ sessionId: "child-1", env: { AUDIT_TOOLS_AGENT_GIT: "1" } });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("C-6: a REGISTERED session gets the full normal gate — BAD blocks with the check text", () => {
    armRegistry("owner-sid");
    stageBadSentinel();
    const r = runCommit({ sessionId: "owner-sid" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("`npm run check` FAILED");
    expect(r.stderr).not.toMatch(/child session/i);
  });

  test("C-7: an UNARMED registry is legacy — unregistered sid commits normally", () => {
    const r = runCommit({ sessionId: "child-1" });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("C-8: push NEVER enters the commit machinery — a BAD sentinel cannot block a push", () => {
    // If runGate / the staged-snapshot round-trip ran on a push, the staged BAD
    // sentinel would block it. Exit 0 proves the narrow detection: push is
    // detected only for the child refusal.
    armRegistry("owner-sid");
    stageBadSentinel();
    const r = runGate("git push", { sessionId: "owner-sid" });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
  });

  test("C-9: no new reach — `git push --no-verify` stays allowed; `git commit --no-verify` stays refused", () => {
    armRegistry("owner-sid");
    const push = runGate("git push --no-verify", { sessionId: "owner-sid" });
    expect(push.status, `expected allow (0); stderr:\n${push.stderr}`).toBe(0);
    const commit = runGate("git commit --no-verify -m x", { sessionId: "owner-sid" });
    expect(commit.status, `expected block (2); stderr:\n${commit.stderr}`).toBe(2);
    expect(commit.stderr).toContain("hook-bypass");
  });

  test("C-10: an id-less CLAUDE process fails open on the commit — ANNOUNCED when the registry is armed (B4)", () => {
    armRegistry();
    const r = runCommit({ env: { CLAUDE_PID: "1" } });
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).toContain("child-session refusal skipped");
  });

  test("C-10b: a plain terminal (no Claude markers at all) commits with no session announcement", () => {
    armRegistry();
    const r = runCommit();
    expect(r.status, `expected allow (0); stderr:\n${r.stderr}`).toBe(0);
    expect(r.stderr).not.toContain("child-session refusal skipped");
  });

  test("C-11: a path-shaped session_id is sanitized, classified unregistered, and refused — no crash", () => {
    armRegistry();
    const r = runCommit({ sessionId: "..\\..\\evil" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/child session/i);
  });

  test("C-12: a chained commit && push is refused once, by the child refusal", () => {
    armRegistry();
    const r = runGate("git commit -m x && git push", { sessionId: "child-1" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/child session/i);
  });

  test("C-13: a heredoc commit-message BODY naming the token is data, not a grant", () => {
    armRegistry();
    // The body line uses the `export` form — WITHOUT heredoc blanking it would
    // match bypassEnabled's anchor and grant the token, so this case is a real
    // pin on the stripHeredocBodies routing (a bare token line would be inert
    // either way: no `m` flag, so `^` never anchors at a body newline).
    const cmd = "git commit -F - <<EOF\nexport AUDIT_TOOLS_AGENT_GIT=1\nEOF";
    const r = runGate(cmd, { sessionId: "child-1" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/child session/i);
  });

  test("C-14: refusal ORDER is deterministic — an unregistered child's `--no-verify` commit hits the hook-bypass refusal, not the child text", () => {
    armRegistry();
    const r = runGate("git commit --no-verify -m x", { sessionId: "child-1" });
    expect(r.status, `expected block (2); stderr:\n${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hook-bypass");
    expect(r.stderr).not.toMatch(/child session/i);
  });
});
