/**
 * Direct tests of the shared host-handoff core (`src/shared/submission/`):
 * derivation determinism, binding-digest and identity refusals, and result-map
 * identity. The audit/remediate host-handoff suites pin their adapters'
 * behavior end-to-end; these pin the core's contracts themselves.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  absoluteHostHandoffResultPath,
  bindingIdentity,
  contentSha256,
  firstDuplicateIdentity,
  hasExactKeys,
  hostHandoffResultPath,
  idsAreStrictlyAscending,
  idsAreUnique,
  isCommit,
  isSha256,
  parseAllWorkloadItems,
  parseWorkloadEnvelope,
  promptSha256,
  resolveHostHandoffPaths,
  resultIdentityIsBound,
  resultMapIdentity,
  sameStrings,
  stringArray,
} from "audit-tools/shared";

const roots: { afterEachCleanups: (() => Promise<void>)[] } = {
  afterEachCleanups: [],
};

afterEach(async () => {
  for (const cleanup of roots.afterEachCleanups.splice(0)) {
    await cleanup();
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "host-handoff-core-"));
  roots.afterEachCleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("resolveHostHandoffPaths", () => {
  it("resolves the flat layout deterministically", async () => {
    const root = await tempRoot();
    const paths = resolveHostHandoffPaths({
      root,
      artifactsDir: join(root, ".audit-tools", "audit"),
      runId: "run-1",
    });
    const again = resolveHostHandoffPaths({
      root,
      artifactsDir: join(root, ".audit-tools", "audit"),
      runId: "run-1",
    });
    expect(paths.workloadPath).toBe(again.workloadPath);
    expect(paths.resultDir).toContain("host-results");
    expect(paths.runDir).toContain(join("runs", "run-1"));
  });

  it("carries run-dir segments as policy, not fork", async () => {
    const root = await tempRoot();
    const laneScoped = resolveHostHandoffPaths({
      root,
      artifactsDir: join(root, ".audit-tools", "remediation"),
      runId: "run-1",
      runDirSegments: ["implement"],
    });
    expect(laneScoped.runDir).toContain(join("runs", "run-1", "implement"));
    // The run id stays the FIRST segment under runs/ — validators join
    // submissions to their run by that segment — and the lane follows it.
    expect(
      relative(join(laneScoped.runDir, ".."), laneScoped.runDir),
    ).toBe("implement");
    // The submission rule is unchanged by the segment: same result dir name.
    expect(laneScoped.resultDir.endsWith("host-results")).toBe(true);
  });

  it("refuses a run id outside the shared grammar", () => {
    expect(() =>
      resolveHostHandoffPaths({
        root: "/tmp/x",
        artifactsDir: "/tmp/x/.audit-tools/audit",
        runId: "../escape",
      }),
    ).toThrow(/Invalid host handoff run id/u);
  });

  it("derives identical bound paths on win32/darwin path spellings", async () => {
    const root = await tempRoot();
    const paths = resolveHostHandoffPaths({
      root,
      artifactsDir: join(root, ".audit-tools", "audit"),
      runId: "r",
    });
    const relativeForm = hostHandoffResultPath(paths, "ITEM-1");
    // Repository-relative, forward-slashed, deterministic in the id alone: the
    // filename IS the sha256 of the id (the shared submission-path rule), and
    // the absolute form is that same path resolved against the repo root.
    expect(relativeForm).not.toContain("\\");
    expect(relativeForm.endsWith(`/${promptSha256("ITEM-1")}.json`)).toBe(true);
    expect(relativeForm).toContain("host-results");
    expect(absoluteHostHandoffResultPath(paths, "ITEM-1")).toBe(
      join(paths.root, relativeForm),
    );
    expect(hostHandoffResultPath(paths, "ITEM-2")).not.toBe(relativeForm);
  });
});

describe("digest helpers", () => {
  it("binds a prompt to its sha256 and refuses nothing else", () => {
    expect(promptSha256("same ask")).toBe(promptSha256("same ask"));
    expect(isSha256(promptSha256("same ask"))).toBe(true);
    expect(promptSha256("same ask")).not.toBe(promptSha256("other ask"));
  });

  it("canonicalizes content before digesting", () => {
    // Key ORDER does not matter; value DOES.
    expect(contentSha256({ a: 1, b: 2 })).toBe(contentSha256({ b: 2, a: 1 }));
    expect(contentSha256({ a: 1 })).not.toBe(contentSha256({ a: 2 }));
  });
});

describe("binding identity and dedupe refusals", () => {
  it("keys identity off work item AND prompt digest", () => {
    const entry = { work_item_id: "wi-1", prompt_sha256: SHA_A };
    expect(bindingIdentity(entry)).toBe(bindingIdentity({ ...entry }));
    expect(bindingIdentity(entry)).not.toBe(
      bindingIdentity({ work_item_id: "wi-1", prompt_sha256: SHA_B }),
    );
    expect(bindingIdentity(entry)).not.toBe(
      bindingIdentity({ work_item_id: "wi-2", prompt_sha256: SHA_A }),
    );
  });

  it("finds exactly the first duplicate identity", () => {
    const entries = [
      { work_item_id: "wi-1", prompt_sha256: SHA_A },
      { work_item_id: "wi-2", prompt_sha256: SHA_B },
      { work_item_id: "wi-1", prompt_sha256: SHA_A },
    ];
    const duplicate = firstDuplicateIdentity(entries, bindingIdentity);
    expect(duplicate).toBe(entries[2]);
    expect(
      firstDuplicateIdentity(entries.slice(0, 2), bindingIdentity),
    ).toBeNull();
  });

  it("strictly ascending covers sorted AND unique; unique alone does not cover sorted", () => {
    expect(idsAreStrictlyAscending(["a", "b", "c"])).toBe(true);
    expect(idsAreStrictlyAscending(["a", "a"])).toBe(false);
    expect(idsAreStrictlyAscending(["b", "a"])).toBe(false);
    expect(idsAreUnique(["b", "a"])).toBe(true);
  });
});

describe("result identity binding", () => {
  const bound = {
    runId: "run-1",
    workItemId: "wi-1",
    promptSha256: SHA_A,
  };

  it("accepts the exact binding with a non-empty result id", () => {
    expect(
      resultIdentityIsBound(
        {
          result_id: "res-1",
          run_id: "run-1",
          work_item_id: "wi-1",
          prompt_sha256: SHA_A,
        },
        bound,
      ),
    ).toBe(true);
  });

  it.each([
    ["empty result_id", { result_id: "" }],
    ["wrong run", { run_id: "run-2" }],
    ["wrong work item", { work_item_id: "wi-9" }],
    ["wrong prompt digest", { prompt_sha256: SHA_B }],
  ])("refuses %s", (_label, override) => {
    expect(
      resultIdentityIsBound(
        {
          result_id: "res-1",
          run_id: "run-1",
          work_item_id: "wi-1",
          prompt_sha256: SHA_A,
          ...override,
        },
        bound,
      ),
    ).toBe(false);
  });

  it("refuses a non-string or absent result_id rather than throwing", () => {
    expect(resultIdentityIsBound({}, bound)).toBe(false);
    expect(
      resultIdentityIsBound({ result_id: 7, run_id: "run-1" }, bound),
    ).toBe(false);
  });
});

describe("result map identity", () => {
  const item = (id: string) => ({
    id,
    prompt: { sha256: promptSha256(id) },
    result_path: `runs/r/host-results/${id}.json`,
  });

  it("returns items keyed by id when the map covers the workload exactly", () => {
    const items = [item("wi-1"), item("wi-2")];
    const entries = items.map((one) => ({
      work_item_id: one.id,
      prompt_sha256: one.prompt.sha256,
      result_path: one.result_path,
    }));
    const identity = resultMapIdentity(items, entries);
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.byId.get("wi-1")?.id).toBe("wi-1");
      expect(identity.byId.size).toBe(2);
    }
  });

  it.each([
    [
      "an entry naming an unknown item",
      [{ work_item_id: "ghost", prompt_sha256: SHA_A, result_path: "x" }],
    ],
    [
      "an entry covering an item twice",
      null,
    ],
    [
      "an entry whose prompt digest belongs to another item",
      undefined,
    ],
    ["a map that under-covers the workload", []],
  ])("refuses %s", (_label, entriesOverride) => {
    const items = [item("wi-1"), item("wi-2")];
    if (entriesOverride === null) {
      const duplicate = items.map((one) => ({
        work_item_id: one.id,
        prompt_sha256: one.prompt.sha256,
        result_path: one.result_path,
      }));
      duplicate.pop();
      duplicate.push(duplicate[0]!);
      expect(resultMapIdentity(items, duplicate).ok).toBe(false);
      return;
    }
    if (entriesOverride === undefined) {
      const swapped = items.map((one) => ({
        work_item_id: one.id,
        prompt_sha256: promptSha256(`other:${one.id}`),
        result_path: one.result_path,
      }));
      expect(resultMapIdentity(items, swapped).ok).toBe(false);
      return;
    }
    const typed = entriesOverride as {
      work_item_id: string;
      prompt_sha256: string;
      result_path: string;
    }[];
    expect(resultMapIdentity(items, typed).ok).toBe(false);
  });

  it("refuses an entry whose bound path diverges from the derivation", () => {
    const items = [item("wi-1")];
    // The refusal is CLASSIFIED as an identity miss — the map named the right
    // item but pinned a path the shared rule does not derive.
    expect(resultMapIdentity(items, [
      {
        work_item_id: "wi-1",
        prompt_sha256: items[0]!.prompt.sha256,
        result_path: "somewhere/else.json",
      },
    ])).toMatchObject({ ok: false, reason: "identity" });
  });
});

describe("workload envelope parsing", () => {
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    contract_version: "x/v1alpha1",
    run_id: "run-1",
    work_items: [],
    ...overrides,
  });

  it("accepts the exact envelope for this run and version", () => {
    const parsed = parseWorkloadEnvelope(envelope(), {
      contractVersion: "x/v1alpha1",
      runId: "run-1",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rawItems).toEqual([]);
  });

  it.each([
    ["another version", envelope({ contract_version: "y/v1alpha1" })],
    ["another run", envelope({ run_id: "run-2" })],
    ["non-array items", envelope({ work_items: {} })],
    ["an extra key", envelope({ extra: true })],
    ["a missing key", { contract_version: "x/v1alpha1", run_id: "run-1" }],
    ["a non-object", "nope"],
  ])("refuses %s", (_label, value) => {
    expect(
      parseWorkloadEnvelope(value, {
        contractVersion: "x/v1alpha1",
        runId: "run-1",
      }).ok,
    ).toBe(false);
  });

  it("maps items through the draw's parser and refuses on ANY failure", () => {
    const rawItems = ["ok", "ok"];
    expect(
      parseAllWorkloadItems(rawItems, (raw) => (raw === "ok" ? raw.length : null)),
    ).toEqual([2, 2]);
    expect(
      parseAllWorkloadItems(["ok", "bad"], (raw) =>
        raw === "ok" ? raw.length : null,
      ),
    ).toBeNull();
  });
});

describe("shared predicates", () => {
  it("hasExactKeys is order-insensitive but exact", () => {
    expect(hasExactKeys({ b: 1, a: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 3 }, ["a", "b"])).toBe(false);
  });

  it("isCommit admits only full sha1/sha256 forms", () => {
    expect(isCommit("1".repeat(40))).toBe(true);
    expect(isCommit("1".repeat(64))).toBe(true);
    expect(isCommit("1".repeat(7))).toBe(false);
    expect(isCommit("g".repeat(40))).toBe(false);
  });

  it("sameStrings is order-significant; stringArray admits only string arrays", () => {
    expect(sameStrings(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameStrings(["a", "b"], ["b", "a"])).toBe(false);
    expect(stringArray(["a"])).toEqual(["a"]);
    expect(stringArray([1])).toBeNull();
    expect(stringArray("a")).toBeNull();
  });
});
