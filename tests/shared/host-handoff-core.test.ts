/**
 * Direct tests of the shared host-handoff core (`src/shared/submission/`):
 * derivation determinism, binding-digest and identity refusals, and result-map
 * identity. The audit/remediate host-handoff suites pin their adapters'
 * behavior end-to-end; these pin the core's contracts themselves.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RUN_ID_DIGEST_LENGTH,
  RUN_ID_PREFIX,
  RUN_ID_SLUG_MAX_LENGTH,
} from "../../src/audit/io/runArtifacts.js";

import {
  bindingIdentity,
  contentSha256,
  describeIdentityFailure,
  firstDuplicateIdentity,
  firstFailedIdentityComponent,
  hasExactKeys,
  hostHandoffResultPath,
  IDENTITY_COMPONENTS,
  identityFailureDiagnostic,
  idsAreStrictlyAscending,
  isCommit,
  isSha256,
  parseAllWorkloadItems,
  parseWorkloadEnvelope,
  promptSha256,
  resolveHostHandoffPaths,
  resultMapIdentity,
  sameStrings,
  stringArray,
} from "audit-tools/shared";
// The absolute form of a bound result path has no production consumer (it was
// deleted from the core), so this pins it through the module that OWNs the
// containment rule the core applied — `resolveContainedPath` — rather than
// through an export kept alive for the test's benefit.
import { resolveContainedPath } from "../../src/shared/submission/submissionIdentity.js";

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

  it("accepts every run id the audit draw's discovery grammar produces, and refuses the rest", () => {
    // The audit draw's run id is DERIVED, not minted from a clock, so a
    // republication re-derives an id a host is already holding — and the derived
    // form is what the shared grammar has to admit. The two rules are ONE
    // contract and must not disagree.
    const derived = `review-audit_tasks_completed-${"f".repeat(RUN_ID_DIGEST_LENGTH)}`;
    expect(() =>
      resolveHostHandoffPaths({
        root: "/tmp/x",
        artifactsDir: "/tmp/x/.audit-tools/audit",
        runId: derived,
      }),
    ).not.toThrow();

    // The derived id at its WORST CASE, built from the derivation's own
    // constants rather than a transcription of them: a maximal obligation slug
    // (capped at `RUN_ID_SLUG_MAX_LENGTH`) under the fixed prefix and digest. If
    // the cap or the digest grows past the shared 128-character limit, THIS id
    // stops being accepted and this test reds — which is the point. A
    // hand-written fixture would keep passing while production minted run ids
    // whose own paths throw.
    const worstCase = `${RUN_ID_PREFIX}${"a".repeat(RUN_ID_SLUG_MAX_LENGTH)}${"-"}${"f".repeat(RUN_ID_DIGEST_LENGTH)}`;
    expect(() =>
      resolveHostHandoffPaths({
        root: "/tmp/x",
        artifactsDir: "/tmp/x/.audit-tools/audit",
        runId: worstCase,
      }),
    ).not.toThrow();

    // A path segment can never be "." / ".." or start outside the grammar. The
    // 128-character limit is EXCLUSIVE, so it is crossed by PADDING the derived
    // form to just past it — derived here rather than transcribed, so this arm
    // tracks the shared rule instead of a remembered number.
    const tooLong = `${worstCase}${"a".repeat(128)}`;
    for (const refused of ["", ".", "..", "-leading", `has/slash`, tooLong]) {
      expect(() =>
        resolveHostHandoffPaths({
          root: "/tmp/x",
          artifactsDir: "/tmp/x/.audit-tools/audit",
          runId: refused,
        }),
      ).toThrow(/Invalid host handoff run id/u);
    }
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
    expect(resolveContainedPath(paths.root, relativeForm, "ITEM-1")).toBe(
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
    // The "distinct but unsorted" case is the ONLY thing `idsAreUnique` used to
    // add, and `idsAreStrictlyAscending` subsumes it: it is false there, so the
    // duplicate refusal never has to consult a second predicate. The bare
    // predicate was deleted with it.
    expect(idsAreStrictlyAscending(["a", "c", "b"])).toBe(false);
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
      firstFailedIdentityComponent(
        {
          result_id: "res-1",
          run_id: "run-1",
          work_item_id: "wi-1",
          prompt_sha256: SHA_A,
        },
        bound,
      ),
    ).toBeNull();
  });

  it.each([
    ["empty result_id", { result_id: "" }, "result_id"],
    ["wrong run", { run_id: "run-2" }, "run_id"],
    ["wrong work item", { work_item_id: "wi-9" }, "work_item_id"],
    ["wrong prompt digest", { prompt_sha256: SHA_B }, "prompt_sha256"],
  ])("refuses %s", (_label, override, component) => {
    expect(
      firstFailedIdentityComponent(
        {
          result_id: "res-1",
          run_id: "run-1",
          work_item_id: "wi-1",
          prompt_sha256: SHA_A,
          ...override,
        },
        bound,
      ),
    ).toBe(component);
  });

  it("refuses a non-string or absent result_id rather than throwing", () => {
    expect(firstFailedIdentityComponent({}, bound)).toBe("result_id");
    expect(
      firstFailedIdentityComponent({ result_id: 7, run_id: "run-1" }, bound),
    ).toBe("result_id");
  });

  it("reports the FIRST failed component, in the one order both draws walk", () => {
    // ORDER IS THE CONTRACT. A stale worker's answer typically breaks several
    // components at once, and the two draws used to evaluate them in their own
    // orders — so the same submission produced a different diagnostic depending
    // on which half of the pipeline read it. `IDENTITY_COMPONENTS` is that order
    // and it is pinned here, member by member.
    expect(IDENTITY_COMPONENTS).toEqual([
      "result_id",
      "run_id",
      "work_item_id",
      "prompt_sha256",
    ]);

    // Everything wrong at once: the most fundamental component wins.
    expect(
      firstFailedIdentityComponent(
        { result_id: "", run_id: "run-2", work_item_id: "wi-9", prompt_sha256: SHA_B },
        bound,
      ),
    ).toBe("result_id");
    // Drop the first failure and the next in the order surfaces, not the last.
    expect(
      firstFailedIdentityComponent(
        { result_id: "res-1", run_id: "run-2", work_item_id: "wi-9", prompt_sha256: SHA_B },
        bound,
      ),
    ).toBe("run_id");
    expect(
      firstFailedIdentityComponent(
        { result_id: "res-1", run_id: "run-1", work_item_id: "wi-9", prompt_sha256: SHA_B },
        bound,
      ),
    ).toBe("work_item_id");
    expect(
      firstFailedIdentityComponent(
        { result_id: "res-1", run_id: "run-1", work_item_id: "wi-1", prompt_sha256: SHA_B },
        bound,
      ),
    ).toBe("prompt_sha256");
    expect(
      firstFailedIdentityComponent(
        { result_id: "res-1", run_id: "run-1", work_item_id: "wi-1", prompt_sha256: SHA_A },
        bound,
      ),
    ).toBeNull();
  });

  // The per-component DESCRIPTIONS are the shared vocabulary both draws render.
  // Every member of the union must have one — a component with no description
  // would render an empty diagnostic on a draw that adopted it — and the two
  // helpers must agree about which component broke.
  it("describes every component the walk can return, and only those", () => {
    for (const component of IDENTITY_COMPONENTS) {
      const description = describeIdentityFailure(component);
      expect(description.length, `description for '${component}'`).toBeGreaterThan(0);
      // The description NAMES its component: that is the whole repair signal a
      // host gets, and an undifferentiated sentence is the defect this replaces.
      expect(description, `description for '${component}'`).toContain(component);
    }
    // Distinct: two components sharing a sentence would be one diagnostic for
    // two different repairs, which is the collapse this replaces.
    const descriptions = IDENTITY_COMPONENTS.map(describeIdentityFailure);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("renders one diagnostic per broken submission, keyed to the first failure", () => {
    for (const value of [
      { result_id: "res-1", run_id: "run-1", work_item_id: "wi-1", prompt_sha256: SHA_A },
      { result_id: "", run_id: "run-1", work_item_id: "wi-1", prompt_sha256: SHA_A },
      { result_id: "res-1", run_id: "run-2", work_item_id: "wi-1", prompt_sha256: SHA_A },
      { result_id: "res-1" },
      {},
    ]) {
      const component = firstFailedIdentityComponent(value, bound);
      expect(identityFailureDiagnostic(value, bound)).toBe(
        component === null ? null : describeIdentityFailure(component),
      );
    }
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

// ── F6: ONE diagnostic vocabulary for the identity refusal ───────────────────
//
// Both draws walk `IDENTITY_COMPONENTS` in one order, and both must SAY the
// same thing when a component breaks. Audit named the broken component;
// remediate emitted one of two undifferentiated sentences that named none of
// them — so which field to repair was legible only when the audit half happened
// to be the one that read the submission. The core now exposes the description
// and the two draws both render it; this pins that they do, from the source
// that emits it.
describe("F6: both draws render the core's identity diagnostic", () => {
  const AUDIT = join(process.cwd(), "src", "audit", "cli", "dispatch", "hostHandoff.ts");
  const REMEDIATE = join(
    process.cwd(),
    "src",
    "remediate",
    "steps",
    "dispatch",
    "hostHandoff.ts",
  );

  /**
   * Each draw's binding name → the refusal message that renders it. The draw
   * picks its own variable name, so the name is READ from the call rather than
   * assumed; what must hold is that the shared description reaches the message.
   */
  function diagnosticBindings(source: string): Array<{
    readonly name: string;
    readonly interpolation: string;
  }> {
    const bindings: Array<{ name: string; interpolation: string }> = [];
    for (const statement of source.split("const ").slice(1)) {
      const call = statement.indexOf("identityFailureDiagnostic(");
      if (call < 0) continue;
      const name = statement.slice(0, statement.indexOf("=")).trim();
      bindings.push({ name, interpolation: "$" + "{" + name + "}" });
    }
    return bindings;
  }

  it.each([
    ["audit", AUDIT],
    ["remediate", REMEDIATE],
  ])("%s draw renders the core's diagnostic rather than its own wording", (_draw, path) => {
    const source = readFileSync(path, "utf8");
    const bindings = diagnosticBindings(source);
    expect(bindings.length, `${_draw} identity-diagnostic call sites`).toBeGreaterThan(0);
    for (const binding of bindings) {
      // The core's sentence is INTERPOLATED into this draw's framing — that is
      // the whole single-sourcing. A draw that named components itself would
      // not call the helper at all, which the count above already catches.
      expect(source, `${_draw} renders '${binding.name}'`).toContain(
        `: ${binding.interpolation}`,
      );
    }
  });

  it("the remediate draw interpolates it at BOTH call sites, decision and result", () => {
    // Remediate parses two result documents — a landed result and a decision —
    // and each used to carry its OWN undifferentiated sentence. Two sites is
    // the count the fix owes; one would leave the other collapsed.
    const bindings = diagnosticBindings(readFileSync(REMEDIATE, "utf8"));
    expect(bindings.length).toBe(2);
    // Distinct bindings, not one reused: the two parses are separate functions.
    expect(new Set(bindings.map((binding) => binding.name)).size).toBe(2);
  });

  it("the audit draw no longer carries an unreachable per-component branch", () => {
    const source = readFileSync(AUDIT, "utf8");
    // `result_id` cannot be the FIRST failure on the audit draw: the envelope
    // check above the walk already requires a non-empty string, so a branch for
    // it is dead — and a dead branch in the vocabulary is how the two draws
    // drifted apart in the first place.
    expect(source).not.toContain('identityFailure === "result_id"');
    // Neither draw names a component in a conditional any more; the core's
    // description is the only place a component's name is rendered.
    for (const component of IDENTITY_COMPONENTS) {
      expect(source, `audit branch for '${component}'`).not.toContain(
        `identityFailure === "${component}"`,
      );
    }
  });
});
