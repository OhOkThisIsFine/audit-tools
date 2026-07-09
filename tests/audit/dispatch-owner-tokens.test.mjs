/**
 * dispatch-owner-tokens.test.mjs (D-66/67 slice-1, Part A) — `prepareDispatchArtifacts`
 * persists `ClaimRegistry.claimMany`'s minted owner tokens into the run-scoped
 * `runs/<runId>/owner-tokens.json` sidecar (never `active-dispatch.json` — see
 * `ownerTokens.ts`), additively across dispatch rounds, and now covers the A-8
 * hybrid `tasksOverride` path too (previously exempt from task claiming entirely).
 */
import { test, onTestFinished, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareDispatchArtifacts } = await import("../../src/audit/cli/dispatch.ts");
const { packageRoot } = await import("../../src/audit/cli/paths.ts");
const { readOwnerTokens, ownerTokensPath } = await import("../../src/audit/cli/ownerTokens.ts");
const { ClaimRegistry, taskClaimsPath } = await import("audit-tools/shared");

const RUN_ID = "test-run-owner-tokens";

function task(id, priority = "medium") {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: `pass:${id}`,
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: 40 },
    rationale: `review ${id}`,
    priority,
  };
}

async function makeArtifactsDir() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-owner-tokens-"));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  return artifactsDir;
}

async function writePending(artifactsDir, tasks) {
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify(tasks), "utf8");
  return runDir;
}

function run(artifactsDir, extra = {}) {
  return prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    ...extra,
  });
}

test("prepareDispatchArtifacts persists claimMany's owner tokens into the run-scoped sidecar", async () => {
  const artifactsDir = await makeArtifactsDir();
  const runDir = await writePending(artifactsDir, [task("a"), task("b")]);

  const result = await run(artifactsDir);
  expect(result.task_count).toBe(2);

  const tokens = await readOwnerTokens(runDir);
  expect(Object.keys(tokens).sort()).toEqual(["a", "b"]);
  expect(typeof tokens.a).toBe("string");
  expect(typeof tokens.b).toBe("string");

  // The token in the sidecar is the SAME one claimMany minted — heartbeat succeeds.
  const registry = new ClaimRegistry(taskClaimsPath(artifactsDir));
  expect(await registry.heartbeat("a", tokens.a)).toBe(true);
  expect(await registry.heartbeat("b", tokens.b)).toBe(true);
});

test("owner-tokens sidecar merges additively across a second dispatch round (no clobber of an untouched task's token)", async () => {
  const artifactsDir = await makeArtifactsDir();
  const runDir = await writePending(artifactsDir, [task("a"), task("b")]);

  await run(artifactsDir);
  const afterRound1 = await readOwnerTokens(runDir);
  const tokenAAfterRound1 = afterRound1.a;
  expect(typeof tokenAAfterRound1).toBe("string");

  // Round 2: pending set now excludes "a" (already answered / pruned) and adds
  // "c". A same-pool re-grant is not exercised for "a" here — it simply isn't a
  // candidate this round — so its round-1 token must survive UNCHANGED in the
  // sidecar (additive merge), while "c" gets a freshly persisted token.
  await writePending(artifactsDir, [task("c")]);
  await run(artifactsDir);
  const afterRound2 = await readOwnerTokens(runDir);

  expect(afterRound2.a, "round-1 token for an untouched task is preserved").toBe(tokenAAfterRound1);
  expect(typeof afterRound2.c, "round-2 introduces a token for the new task").toBe("string");
});

test("owner-tokens sidecar rotates a task's token when the SAME run re-claims it in a later round", async () => {
  const artifactsDir = await makeArtifactsDir();
  const runDir = await writePending(artifactsDir, [task("a")]);

  await run(artifactsDir);
  const tokenRound1 = (await readOwnerTokens(runDir)).a;

  // Same pending set again (idempotent re-partition, e.g. a resumed drain):
  // claimMany re-grants "a" to the SAME poolId (runId) and MINTS A FRESH token.
  await run(artifactsDir);
  const tokenRound2 = (await readOwnerTokens(runDir)).a;

  expect(tokenRound2).not.toBe(tokenRound1);
  const registry = new ClaimRegistry(taskClaimsPath(artifactsDir));
  expect(await registry.heartbeat("a", tokenRound2)).toBe(true);
});

test("A-8 hybrid tasksOverride dispatch ALSO claims its tasks and persists their owner tokens", async () => {
  const artifactsDir = await makeArtifactsDir();
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  // No pending-audit-tasks.json written — the override subset must bypass it
  // entirely, exactly as before this change (only the CLAIMING behavior is new).

  const overrideTasks = [task("nim-1"), task("nim-2")];
  const result = await run(artifactsDir, { tasksOverride: overrideTasks });

  expect(result.task_count).toBe(2);

  const tokens = await readOwnerTokens(runDir);
  expect(Object.keys(tokens).sort()).toEqual(["nim-1", "nim-2"]);

  // The tasks are actually claimed on task-claims.json (a DIFFERENT registry from
  // the coordinator's own audit-node-claims.json pre-assignment claim) — a peer
  // partitioning the SAME task_ids under a different runId would now see them held.
  const registry = new ClaimRegistry(taskClaimsPath(artifactsDir));
  const claims = await registry.listClaims();
  expect(claims["nim-1"]).toBeTruthy();
  expect(claims["nim-2"]).toBeTruthy();
  expect(await registry.heartbeat("nim-1", tokens["nim-1"])).toBe(true);
});

test("ownerTokensPath is scoped under runs/<runId>/, not active-dispatch.json's artifactsDir root", async () => {
  const artifactsDir = await makeArtifactsDir();
  const runDir = await writePending(artifactsDir, [task("a")]);
  await run(artifactsDir);

  // The sidecar lives at runs/<runId>/owner-tokens.json.
  const raw = await readFile(ownerTokensPath(runDir), "utf8");
  expect(JSON.parse(raw).a, "sidecar is a plain task_id -> token map").toBeTruthy();
});
