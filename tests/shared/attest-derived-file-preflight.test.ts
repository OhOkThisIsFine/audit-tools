// P19 (owner decision sol-1, 2026-08-12): an attestation binds to the exact
// staged tree, but the gate that judges that tree runs later, at commit — so a
// stale derived file (backlog seek index, HANDOFF roadmap, …) used to void the
// attestation that was just written and force the same review to be attested
// twice (4 records / 3 dates). The attest scripts now run the gate's own
// derived-file checks BEFORE binding and refuse to write an attestation for a
// tree the gate would reject. The trigger predicates are single-sourced in
// scripts/shared/derived-file-preflight.mjs — the gate and both attest scripts
// import the same module, because a hand-kept second copy of the trigger list
// is a worse trap than the one this fixes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  pinsDocManifest,
  pinsBacklogIndex,
  guardReachWired,
  evaluateTriggeredChecks,
} from "../../scripts/shared/derived-file-preflight.mjs";

const REPO_ROOT = join(__dirname, "..", "..");
const ATTEST_LOOP_CORE = join(REPO_ROOT, ".claude", "hooks", "attest-loop-core-review.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real git repo with one loop-core file and a backlog doc staged on top of a base commit. */
function makeFixture(opts: { backlogIndexScript?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "attest-preflight-"));
  dirs.push(root);
  const git = (...args: string[]) => {
    const r = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const scripts: Record<string, string> = {};
  if (opts.backlogIndexScript) scripts["check:backlog-index"] = opts.backlogIndexScript;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts }, null, 2));
  mkdirSync(join(root, "src", "audit", "orchestrator"), { recursive: true });
  writeFileSync(join(root, "src", "audit", "orchestrator", "advance.ts"), "export const base = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  // Stage a loop-core edit plus a backlog doc WITHOUT any index regeneration —
  // the exact shape that used to void a freshly-written attestation.
  writeFileSync(join(root, "src", "audit", "orchestrator", "advance.ts"), "export const base = 2;\n");
  mkdirSync(join(root, "docs", "backlog"), { recursive: true });
  writeFileSync(join(root, "docs", "backlog", "open-bugs.md"), "- a stale-index-shaped edit\n");
  git("add", "-A");
  return root;
}

function runAttest(root: string) {
  return spawnSyncHidden(
    "node",
    [ATTEST_LOOP_CORE, "--attester-class", "agent", "--checked", "preflight contract test adversarial pass"],
    { cwd: root, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
  );
}

function attestationCount(root: string): number {
  const dir = join(root, ".claude", "loop-core-review");
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

describe("attest preflight refuses to bind a tree the gate would reject", () => {
  it("REFUSES to write an attestation when a triggered derived-file check fails", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(1)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/check:backlog-index/);
    expect(`${r.stdout}${r.stderr}`).toMatch(/generate-backlog-index/);
    expect(attestationCount(root)).toBe(0);
  });

  it("binds normally when the triggered checks pass", () => {
    const root = makeFixture({ backlogIndexScript: 'node -e "process.exit(0)"' });
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(attestationCount(root)).toBe(1);
  });

  it("FAILS OPEN with an announcement when a triggered check is not wired", () => {
    const root = makeFixture(); // no check scripts at all
    const r = runAttest(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(attestationCount(root)).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/SKIPPED|not wired/);
  });
});

describe("the trigger predicates are the gate's, single-sourced", () => {
  it("pinsDocManifest fires on any markdown and the manifest data, nothing else", () => {
    expect(pinsDocManifest("docs/HANDOFF.md")).toBe(true);
    expect(pinsDocManifest("spec\\audit\\audit-goals.md")).toBe(true);
    expect(pinsDocManifest("scripts/doc-manifest-data.mjs")).toBe(true);
    expect(pinsDocManifest("src/audit/cli.ts")).toBe(false);
  });

  it("pinsBacklogIndex fires on the backlog index and its sources only", () => {
    expect(pinsBacklogIndex("docs/backlog.md")).toBe(true);
    expect(pinsBacklogIndex("docs/backlog/open-bugs.md")).toBe(true);
    expect(pinsBacklogIndex("docs/backlog/sub/deep.md")).toBe(false);
    expect(pinsBacklogIndex("docs/reviews/x.md")).toBe(false);
  });

  it("guard-reach is included only when the repo wires it", () => {
    const root = makeFixture();
    expect(guardReachWired(root)).toBe(false);
    expect(guardReachWired(REPO_ROOT)).toBe(true);
    const triggered = evaluateTriggeredChecks({ root, staged: ["src/audit/orchestrator/advance.ts"] });
    expect(triggered.map((c) => c.id)).not.toContain("doc-manifest");
  });

  it("a loop-core-only staged set triggers no doc/backlog checks", () => {
    const root = makeFixture();
    const ids = evaluateTriggeredChecks({ root, staged: ["src/audit/orchestrator/advance.ts"] }).map(
      (c) => c.id,
    );
    expect(ids).not.toContain("doc-manifest");
    expect(ids).not.toContain("backlog-index");
    expect(ids).not.toContain("handoff-roadmap");
  });

  it("the gate and BOTH attest scripts import the shared module — no second copy", () => {
    for (const f of [
      ".claude/hooks/pre-commit-gate.mjs",
      ".claude/hooks/attest-loop-core-review.mjs",
      "scripts/attest-constitutional-doc-change.mjs",
    ]) {
      expect(readFileSync(join(REPO_ROOT, f), "utf8"), `${f} must import the shared module`).toMatch(
        /derived-file-preflight\.mjs/,
      );
    }
  });
});
