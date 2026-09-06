import { describe, it, expect } from "vitest";

const { parseArtifactDefinitions, parseExecutorRegistry, parseDependencyMap } =
  await import("../../scripts/shared/generate-spec-mirrors.mjs");

// `as const` on a registry entry is legal TypeScript with exactly the same
// meaning as the bare literal. Whether a generator ACCEPTS it must not depend on
// which of this file's three parsers happens to read the property: one parser
// peeling and another refusing is a single file disagreeing with itself, and the
// author who hits it gets a refusal that names the value rather than the
// inconsistency.
//
// These pin the agreement. They are parser-level, so they cannot be satisfied by
// the current repo registries happening to avoid `as const`.

describe("generate-spec-mirrors parsers agree on wrapped literals", () => {
  it("parseArtifactDefinitions reads an `as const` call", () => {
    const definitions = parseArtifactDefinitions(
      'export const ARTIFACT_DEFINITIONS = { alpha: jsonArtifact("alpha.json", "extract") as const };',
      new Map(),
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      key: "alpha",
      fileName: "alpha.json",
      phase: "extract",
    });
  });

  it("parseExecutorRegistry reads an `as const` id and kind", () => {
    const executors = parseExecutorRegistry(
      'export const EXECUTOR_REGISTRY = [{ id: "alpha" as const, kind: "deterministic" as const, obligation_ids: ["OBL-a"] as const }];',
    );
    expect(executors).toEqual([
      { id: "alpha", kind: "deterministic", obligations: ["OBL-a"] },
    ]);
  });

  it("parseDependencyMap reads an `as const` upstream array", () => {
    const map = parseDependencyMap(
      'export const ARTIFACT_DEPENDS_ON_MAP = { "beta.json": ["alpha.json"] as const };',
      new Map([
        ["alpha.json", "alpha.json"],
        ["beta.json", "beta.json"],
      ]),
    );
    expect(map).toEqual([{ artifact: "beta.json", dependsOn: ["alpha.json"] }]);
  });
});
