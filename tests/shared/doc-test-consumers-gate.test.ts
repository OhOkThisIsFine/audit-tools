// Contract tests for the declared doc → test consumer map.
//
// WHY. A contract-bearing doc edit had no edit-time surface naming the tests
// that assert its content: `docs/nightly-routine.md`'s approved lane swap was
// green through every local doc gate and failed release CI on a parity test that
// pinned the retired helper invocation verbatim, burning tag v0.34.40. The cost
// was not the failure — it was that only the whole suite could reveal it, and no
// doc edit runs the whole suite.
//
// WHAT IS ENFORCED is only the map's SHAPE, and these cases pin exactly that
// boundary. Whether the named tests still ASSERT the doc, and whether an unmapped
// doc is uncovered, are both statementable-but-undecidable here — the map row
// says so in its own header rather than letting a green check imply coverage.
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeStagedHits,
  stagedConsumers,
  validateMap,
} from "../../scripts/check-doc-test-consumers.mjs";
import { DOC_TEST_CONSUMERS } from "../../scripts/doc-test-consumers-data.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const row = (over: Record<string, unknown>) => ({
  doc: "docs/a.md",
  tests: ["tests/a.test.ts"],
  what: "x".repeat(30),
  ...over,
});

describe("the map's shape — what the gate can and cannot enforce", () => {
  it("accepts a well-formed row", () => {
    expect(validateMap([row({})], () => true)).toEqual([]);
  });

  it("refuses a doc that is not tracked — a map of paths that no longer exist", () => {
    const errors = validateMap([row({ doc: "docs/gone.md" })], (p: string) => p !== "docs/gone.md");
    expect(errors.join("\n")).toMatch(/docs\/gone\.md is not a tracked file/);
  });

  it("refuses a test that is not tracked — a consumer that cannot run", () => {
    const errors = validateMap([row({ tests: ["tests/gone.test.ts"] })], (p: string) => p === "docs/a.md");
    expect(errors.join("\n")).toMatch(/tests\/gone\.test\.ts is not a tracked file/);
  });

  it("refuses a row with no consumer, and a row with no `what`", () => {
    expect(validateMap([row({ tests: [] })], () => true).join("\n")).toMatch(
      /names no test/,
    );
    expect(validateMap([row({ what: "short" })], () => true).join("\n")).toMatch(
      /states no `what`/,
    );
  });

  it("refuses TWO rows for one doc — a second row is how a map grows two answers", () => {
    const errors = validateMap([row({}), row({})], () => true);
    expect(errors.join("\n")).toMatch(/mapped by more than one row/);
  });

  it("states its own uncovered half rather than letting green imply coverage", () => {
    // The map cannot tell whether the named tests still ASSERT the doc. That is
    // declared in the module header and in the guard-reach row, and this pins
    // that the declaration exists — a silent map would read as full coverage.
    const header = readFileSync(
      resolve(REPO_ROOT, "scripts/doc-test-consumers-data.mjs"),
      "utf8",
    );
    expect(header).toMatch(/unclaimed/i);
    expect(header).toMatch(/curated/i);
    expect(header).toMatch(/not claimed to be uncovered/i);
  });
});

describe("the staged surface — a doc edit is handed its consumers", () => {
  it("reports the consumers of a mapped staged doc", () => {
    const hits = describeStagedHits("docs/HANDOFF.md\nsrc/unrelated.ts");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/docs\/HANDOFF\.md → asserts:/);
    expect(hits[0]).toMatch(/tests\/shared\/handoff-roadmap\.test\.ts/);
  });

  it("says nothing for a staged doc the map does not claim", () => {
    expect(describeStagedHits("src/unrelated.ts")).toEqual([]);
  });

  it("matches on the EXACT doc path, never a prefix or a basename", () => {
    // A `docs/HANDOFF.md.bak` or a nested `x/docs/HANDOFF.md` is a different
    // doc; a prefix match would hand the editor consumers that do not apply.
    expect(stagedConsumers(DOC_TEST_CONSUMERS, ["docs/HANDOFF.md.bak"])).toEqual([]);
    expect(stagedConsumers(DOC_TEST_CONSUMERS, ["nested/docs/HANDOFF.md"])).toEqual([]);
  });

  it("the live map's rows all name tracked docs and tests", () => {
    // The live-tree half: a row left behind after a doc or test is deleted is a
    // dead claim that reads as coverage.
    const tracked = new Set<string>(
      execFileSyncHidden("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
        .split(/\r?\n/)
        .filter(Boolean),
    );
    const errors = validateMap(DOC_TEST_CONSUMERS, (path: string) => tracked.has(path));
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
