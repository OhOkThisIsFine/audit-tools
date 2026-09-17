import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditReadState } from "../../src/shared/git.js";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.js";

// `readAuditReadState` is what audit synthesis records as the findings
// contract's `audit_read`, and the remediator's close leg turns that value into
// terminal dispositions. Every case here is one way the value could LIE about
// what the audit read.

const REPO_DIR = scratchDir(".test-audit-read-state");

function git(command: string): string {
  return String(execSync(`git ${command}`, { cwd: REPO_DIR })).trim();
}

function write(path: string, content: string): void {
  writeFileSync(join(REPO_DIR, path), content);
}

beforeEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  git("init");
  git("config user.email test@test.com");
  git("config user.name Test");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  git("add .");
  git("commit -m init");
});

afterEach(async () => {
  await rm(REPO_DIR, { recursive: true, force: true });
});

describe("readAuditReadState", () => {
  it("states HEAD and an empty dirty set for a clean tree", async () => {
    expect(await readAuditReadState(REPO_DIR)).toEqual({
      commit: git("rev-parse HEAD"),
      dirty_paths: [],
    });
  });

  it("lists modified, staged and untracked paths in code-unit order, and never the tool's own state dir", async () => {
    write("src/b.ts", "export const b = 2;\n"); // modified, unstaged
    write("src/a.ts", "export const a = 2;\n"); // modified, staged
    git("add src/a.ts");
    write("src/Z new.ts", "export const z = 1;\n"); // untracked, with a space
    await mkdir(join(REPO_DIR, ".audit-tools", "audit"), { recursive: true });
    write(".audit-tools/audit/state.json", "{}"); // the tool's own writes

    const state = await readAuditReadState(REPO_DIR);

    expect(state?.dirty_paths).toEqual(["src/Z new.ts", "src/a.ts", "src/b.ts"]);
  });

  it("lists BOTH paths of an uncommitted rename: the old path's blob at the commit is not what the audit read either", async () => {
    git("mv src/a.ts src/renamed.ts");

    const state = await readAuditReadState(REPO_DIR);

    // Rename detection would report only `src/renamed.ts`, leaving `src/a.ts`
    // looking committed-and-unchanged to a consumer.
    expect(state?.dirty_paths).toEqual(["src/a.ts", "src/renamed.ts"]);
  });

  it("answers null — never a partial value — outside a git repository", async () => {
    const plain = scratchDir(".test-audit-read-state-plain");
    await rm(plain, { recursive: true, force: true });
    await mkdir(plain, { recursive: true });
    try {
      expect(await readAuditReadState(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("answers null for a root nested below the repository root, where git's paths would not match cited paths", async () => {
    expect(await readAuditReadState(join(REPO_DIR, "src"))).toBeNull();
  });

  it("FAILS CLOSED: a listing that fails is null, never an empty dirty set", async () => {
    // HEAD still resolves (rev-parse reads refs, not the index), but every
    // index-reading command fails. An empty `dirty_paths` here would claim the
    // tree was clean on the strength of a command that never answered.
    write("src/a.ts", "export const a = 3;\n");
    writeFileSync(join(REPO_DIR, ".git", "index"), "not an index");

    expect(await readAuditReadState(REPO_DIR)).toBeNull();
  });

  describe("stability across a re-synthesis", () => {
    it("keeps the prior value when the tree still differs from the prior commit by exactly the prior dirty set", async () => {
      const prior = await readAuditReadState(REPO_DIR);
      git("commit --allow-empty -m nothing-the-audit-read-changed");
      expect(git("rev-parse HEAD")).not.toBe(prior?.commit);

      // Byte-identical to `prior`: the report's content hash must not move, or
      // the narrative pass re-runs for a commit that changed nothing.
      expect(await readAuditReadState(REPO_DIR, prior)).toEqual(prior);
    });

    it("re-stamps HEAD when a later commit only COMMITTED the previously dirty files: the fresh value says more", async () => {
      write("src/a.ts", "export const a = 5;\n");
      const prior = await readAuditReadState(REPO_DIR);
      expect(prior?.dirty_paths).toEqual(["src/a.ts"]);
      git("add .");
      git("commit -m commit-the-dirty-file");

      // The tree still differs from the prior commit by exactly `src/a.ts`, so
      // the prior value is still TRUE — but it would keep `src/a.ts` marked
      // uncommitted forever, and every finding in it withheld.
      expect(await readAuditReadState(REPO_DIR, prior)).toEqual({
        commit: git("rev-parse HEAD"),
        dirty_paths: [],
      });
    });

    it("re-stamps HEAD when a file changed since the prior commit", async () => {
      const prior = await readAuditReadState(REPO_DIR);
      write("src/a.ts", "export const a = 9;\n");
      git("add .");
      git("commit -m change");

      expect(await readAuditReadState(REPO_DIR, prior)).toEqual({
        commit: git("rev-parse HEAD"),
        dirty_paths: [],
      });
    });

    it("re-stamps HEAD when the prior commit does not resolve in this repository", async () => {
      const state = await readAuditReadState(REPO_DIR, {
        commit: "f".repeat(40),
        dirty_paths: [],
      });

      expect(state?.commit).toBe(git("rev-parse HEAD"));
    });
  });
});
