// Drift test for the generated table regions in the three `spec/audit` contract
// docs, the renders `check:spec-mirrors` gates.
//
// The gate re-runs the generator against the tree, so it catches a stale region.
// What it cannot catch is the RENDER drifting away from the registries it claims
// to project: a row silently dropped, or one invented in the declaration, would
// still be self-consistent and the gate would stay green — exactly the defect
// these tables had while they were hand-mirrored.
//
// So this asserts the docs against a fresh render of the code registries, and
// pins the two refusals the whole design rests on: membership reconciled in BOTH
// directions, and a splice that refuses a missing or duplicated marker pair
// rather than picking a region.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isConstitutionalDocPath } from "../../scripts/shared/constitutional-doc-paths.generated.mjs";
import { buildPreCommitLegs } from "../../scripts/shared/derived-file-preflight.mjs";
import { describe, expect, it } from "vitest";

import {
  beginMarker,
  readRegistries,
  reconcileRegions,
  renderRegion,
  runGenerator,
  spliceRegion,
} from "../../scripts/shared/generate-spec-mirrors.mjs";
import {
  ARTIFACT_CONTRACT_DOC,
  DEPENDENCY_MAP_DOC,
  DEPENDENCY_MAP_FILE,
  EXECUTOR_CATALOG_DOC,
  SPEC_MIRROR_DOCS,
  SPEC_MIRROR_SOURCE_FILES,
  SPEC_MIRROR_REGIONS,
} from "../../scripts/shared/spec-mirror-data.mjs";

const PROTECTED_DEPENDENCY_DOC = "spec/audit/dependency-map.md";
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const registries = readRegistries(REPO_ROOT);
const docText = (doc: string): string =>
  readFileSync(join(REPO_ROOT, doc), "utf8").replace(/\r\n/g, "\n");

describe("the spec/audit mirror tables are rendered, not restated", () => {
  it("declares a region for every mirror doc", () => {
    expect([...new Set(SPEC_MIRROR_REGIONS.map((region) => region.doc))].sort()).toEqual(
      [...SPEC_MIRROR_DOCS].sort(),
    );
  });

  it.each(SPEC_MIRROR_REGIONS.map((region) => [region.id, region] as const))(
    "%s matches the region currently in its doc",
    (_id, region) => {
      const text = docText(region.doc);
      expect(spliceRegion(text, region.id, renderRegion(region, registries))).toBe(text);
    },
  );

  it("reconciles against the registries with nothing missing on either side", () => {
    expect(reconcileRegions(SPEC_MIRROR_REGIONS, registries)).toEqual([]);
  });

  it("renders every registry row exactly once", () => {
    const rendered = SPEC_MIRROR_REGIONS.flatMap((region) =>
      region.rows.map((row) => `${region.kind}:${row.artifact ?? row.executor}`),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
    for (const entry of registries.artifacts) {
      expect(rendered).toContain(`artifacts:${entry.fileName}`);
    }
    for (const executor of registries.executors) {
      expect(rendered).toContain(`executors:${executor.id}`);
    }
    for (const row of registries.dependencies) {
      expect(rendered).toContain(`dependencies:${row.artifact}`);
    }
  });
});

describe("the reconciliation refuses a declaration the registries do not support", () => {
  const regionOfKind = (kind: string) => {
    const region = SPEC_MIRROR_REGIONS.find(
      (candidate) =>
        candidate.kind === kind && candidate.rows.some((row) => row.registered !== false),
    );
    if (!region) throw new Error(`no ${kind} region is declared — the mirror set is incomplete`);
    return region;
  };

  it.each(["artifacts", "executors", "dependencies"])(
    "reds when a %s row the registry declares is dropped",
    (kind) => {
      const target = regionOfKind(kind);
      const dropped = target.rows.find((row) => row.registered !== false);
      if (!dropped) throw new Error(`no registry-backed row in ${target.id}`);
      const mutated = SPEC_MIRROR_REGIONS.map((region) =>
        region === target
          ? { ...region, rows: region.rows.filter((row) => row !== dropped) }
          : region,
      );
      const errors: string[] = reconcileRegions(mutated, registries);
      expect(errors.join("\n")).toContain(String(dropped.artifact ?? dropped.executor));
    },
  );

  it.each(["artifacts", "executors", "dependencies"])(
    "reds when a %s row no registry holds is invented",
    (kind) => {
      const target = regionOfKind(kind);
      const invented =
        kind === "executors"
          ? { executor: "phantom_executor" }
          : { artifact: "phantom.json", purpose: "invented" };
      const mutated = SPEC_MIRROR_REGIONS.map((region) =>
        region === target ? { ...region, rows: [...region.rows, invented] } : region,
      );
      const errors: string[] = reconcileRegions(mutated, registries);
      expect(errors.join("\n")).toContain(kind === "executors" ? "phantom_executor" : "phantom.json");
    },
  );

  it("reds when a registry row is filed under the wrong phase", () => {
    const target = SPEC_MIRROR_REGIONS.find(
      (region) => region.kind === "artifacts" && region.phase === "intake",
    );
    const mutated = SPEC_MIRROR_REGIONS.map((region) =>
      region === target ? { ...region, phase: "reporting" } : region,
    );
    expect(reconcileRegions(mutated, registries).join("\n")).toMatch(/registry-phase intake/);
  });
});

describe("splicing refuses a doc whose markers it cannot trust", () => {
  const region = SPEC_MIRROR_REGIONS[0];

  // (Splice refusals are pinned once, in
  // tests/shared/generated-artifacts-splice.test.ts.)

  it("names the generator in the banner a reader is told not to edit past", () => {
    expect(beginMarker(region.id)).toContain("scripts/shared/generate-spec-mirrors.mjs");
    expect(beginMarker(region.id)).toContain("DO NOT EDIT BY HAND");
  });
});

describe("dependency mirror uses an exact generated-only reference", () => {
  it("regenerates only the reference after a canonical dependency edit and rejects stale, malformed, or missing output", () => {
    const root = mkdtempSync(join(tmpdir(), "dependency-spec-mirror-"));
    const emit = (check: boolean) => runGenerator({ root, check, out: () => {}, err: () => {} });
    try {
      for (const path of [...SPEC_MIRROR_SOURCE_FILES, ...SPEC_MIRROR_DOCS, PROTECTED_DEPENDENCY_DOC]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), readFileSync(join(REPO_ROOT, path)));
      }
      const read = (path: string) => readFileSync(join(root, path), "utf8");
      const protectedText = read(PROTECTED_DEPENDENCY_DOC);
      const mirror = join(root, DEPENDENCY_MAP_DOC);
      const before = read(DEPENDENCY_MAP_DOC);
      expect(emit(true)).toBe(0);
      const dependencySource = read(DEPENDENCY_MAP_FILE);
      const from = '"repo_manifest.json": ["tooling_manifest.json"]';
      expect(dependencySource).toContain(from);
      writeFileSync(join(root, DEPENDENCY_MAP_FILE), dependencySource.replace(from,
        '"repo_manifest.json": ["tooling_manifest.json", "intent_checkpoint.json"]'));
      expect(emit(true)).toBe(1);
      expect(read(DEPENDENCY_MAP_DOC)).toBe(before);
      expect(emit(false)).toBe(0);
      expect(emit(true)).toBe(0);
      expect(read(DEPENDENCY_MAP_DOC)).toContain("| `repo_manifest.json` | `tooling_manifest.json`, `intent_checkpoint.json` |");
      expect(read(PROTECTED_DEPENDENCY_DOC)).toBe(protectedText);
      writeFileSync(mirror, read(DEPENDENCY_MAP_DOC) + "\nUnapproved prose outside generated markers.\n");
      expect(emit(true)).toBe(1);
      expect(emit(false)).toBe(0);
      expect(emit(true)).toBe(0);
      rmSync(mirror);
      expect(emit(true)).toBe(1);
      expect(emit(false)).toBe(0);
      expect(emit(true)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the protected notes on the constitutional path but routes the reference to mirror checks", () => {
    expect(isConstitutionalDocPath(PROTECTED_DEPENDENCY_DOC)).toBe(true);
    expect(isConstitutionalDocPath(ARTIFACT_CONTRACT_DOC)).toBe(true);
    expect(isConstitutionalDocPath(EXECUTOR_CATALOG_DOC)).toBe(true);
    expect(isConstitutionalDocPath(DEPENDENCY_MAP_DOC)).toBe(false);
    const leg = buildPreCommitLegs().find(leg => leg.id === "check:spec-mirrors");
    expect(leg?.triggered({ staged: [DEPENDENCY_MAP_DOC] })).toBe(true);
    expect(docText(PROTECTED_DEPENDENCY_DOC)).toContain(`[generated dependency tables](dependency-map.generated.md)`);
    expect(docText(PROTECTED_DEPENDENCY_DOC)).not.toContain("BEGIN GENERATED spec-mirror");
    expect(docText(DEPENDENCY_MAP_DOC)).toContain("[dependency rules and notes](dependency-map.md)");
    for (const phase of ["phase-1", "phase-2", "phase-3", "phase-4"]) {
      expect(docText(PROTECTED_DEPENDENCY_DOC)).toContain("(dependency-map.generated.md#" + phase + ")");
      expect(docText(DEPENDENCY_MAP_DOC)).toContain(`<a id="${phase}"></a>`);
    }
  });
});
