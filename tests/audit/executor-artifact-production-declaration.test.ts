/**
 * Contract test: the executor→artifact PRODUCER relation is declared on the
 * registry and matches what the code actually writes.
 *
 * The relation used to live only as a hand-written table in
 * `spec/audit/dependency-map.md`, whose own prose claimed the registries were
 * "the machine-readable ground truth" — they encoded no producer edge at all.
 * `EXECUTOR_REGISTRY[].produces` is now that ground truth and
 * `spec/audit/executor-producers.generated.md` is its render, so this test is
 * what keeps the declaration honest against the source:
 *
 *   DECL-1: every registry entry declares `produces`.
 *   DECL-2: a `primary`/`refresh` declaration names an ARTIFACT_DEFINITIONS
 *           fileName; a `side_channel` declaration names a file deliberately
 *           OUTSIDE the artifact registry and states why.
 *   DECL-3: declared ⊇ extracted — an executor may not write an artifact it
 *           does not declare.
 *   DECL-4: extracted ∪ dynamic ⊇ declared — a declared artifact must have a
 *           literal write site or a data-declared dynamic contributor, so a
 *           shrinking write-set is caught rather than leaving a stale claim.
 *   DECL-5: every ARTIFACT_DEFINITIONS fileName has exactly one primary
 *           producer, or is explicitly declared lifecycle-written.
 *   DECL-6: the write-site data and the registry describe the same executors,
 *           and every dynamic contributor names a real executor + artifact.
 *   DECL-7: a producer property the render cannot read (a concatenation, an
 *           identifier, a call) REFUSES rather than rendering without it.
 *   DECL-8: the tracked render matches a fresh render of the declaration.
 *   DECL-9: every declaration array is in its documented content-derived order,
 *           so re-authoring one cannot churn the render's inputs.
 */

import { describe, it, expect } from "vitest";
import {
  EXECUTOR_REGISTRY,
  LIFECYCLE_PRODUCTIONS,
} from "../../src/audit/orchestrator/executors.js";
import { ARTIFACT_DEFINITIONS } from "../../src/audit/io/artifacts.js";
import {
  DYNAMIC_WRITE_CONTRIBUTORS,
  EXECUTOR_WRITE_SITES,
  extractExecutorWriteSets,
} from "../../scripts/shared/executor-write-sites.mjs";
import {
  RENDER_FILE,
  parseProducerDeclaration,
  readProducerDeclaration,
  renderProducerTable,
} from "../../scripts/shared/generate-executor-producers.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const KNOWN_FILENAMES = new Set(
  Object.values(ARTIFACT_DEFINITIONS).map((definition) => definition.fileName),
);

const EXTRACTED = extractExecutorWriteSets();

const dynamicFor = (executor: string) =>
  new Set(
    DYNAMIC_WRITE_CONTRIBUTORS.filter((c) => c.executor === executor).map((c) => c.artifact),
  );

const sorted = (values: Iterable<string>) => [...values].sort();

describe("executor→artifact production declaration", () => {
  it("DECL-1: every executor declares what it produces", () => {
    // Structural, not a typed read: an entry that simply omits the field must
    // red under `npx vitest run` AND under `npm run check:tests`, not compile-error
    // in one and fail in the other.
    const undeclared = EXECUTOR_REGISTRY.filter(
      (e) => !Object.hasOwn(e, "produces") || !Array.isArray(e.produces),
    ).map((e) => e.id);
    expect(
      undeclared,
      `EXECUTOR_REGISTRY entries with no \`produces\` declaration: [${undeclared.join(", ")}]. ` +
        "The producer relation is declared on the registry, not in the spec table.",
    ).toEqual([]);
  });

  it("DECL-2: declared artifacts are registry artifacts; side-channel writes are named and reasoned", () => {
    const problems: string[] = [];
    for (const executor of EXECUTOR_REGISTRY) {
      for (const production of executor.produces) {
        const known = KNOWN_FILENAMES.has(production.artifact);
        if (production.role === "side_channel") {
          if (known) {
            problems.push(
              `${executor.id} declares ${production.artifact} side_channel, but it IS in ARTIFACT_DEFINITIONS`,
            );
          }
          if (!production.note?.trim()) {
            problems.push(
              `${executor.id} declares side-channel ${production.artifact} with no note stating why it is outside the DAG`,
            );
          }
          continue;
        }
        if (!known) {
          problems.push(
            `${executor.id} declares unknown artifact ${production.artifact} (role ${production.role})`,
          );
        }
      }
    }
    expect(problems.sort()).toEqual([]);
  });

  it("DECL-3: declared ⊇ extracted — no executor writes an artifact it does not declare", () => {
    const problems: string[] = [];
    for (const executor of EXECUTOR_REGISTRY) {
      const declared = new Set(executor.produces.map((p) => p.artifact));
      for (const written of EXTRACTED.get(executor.id) ?? []) {
        if (!declared.has(written)) {
          problems.push(`${executor.id} writes ${written} but does not declare it`);
        }
      }
    }
    expect(
      problems.sort(),
      "Add the missing entry to that executor's `produces` in src/audit/orchestrator/executors.ts, " +
        "then regenerate spec/audit/executor-producers.generated.md.",
    ).toEqual([]);
  });

  it("DECL-4: extracted ∪ dynamic ⊇ declared — no declaration without a writer", () => {
    const problems: string[] = [];
    for (const executor of EXECUTOR_REGISTRY) {
      const extracted = EXTRACTED.get(executor.id) ?? new Set<string>();
      const dynamic = dynamicFor(executor.id);
      for (const production of executor.produces) {
        if (!extracted.has(production.artifact) && !dynamic.has(production.artifact)) {
          problems.push(`${executor.id} declares ${production.artifact}, which nothing in its source writes`);
        }
      }
    }
    expect(
      problems.sort(),
      "Either the declaration is stale (drop it) or the write is computed rather than literal " +
        "(declare it in DYNAMIC_WRITE_CONTRIBUTORS with its reason).",
    ).toEqual([]);
  });

  it("DECL-5: every registry artifact has exactly one primary producer or is declared lifecycle-written", () => {
    const lifecycle = new Set(LIFECYCLE_PRODUCTIONS.map((entry) => entry.artifact));
    const primaries = new Map<string, string[]>();
    for (const executor of EXECUTOR_REGISTRY) {
      for (const production of executor.produces) {
        if (production.role !== "primary") continue;
        primaries.set(production.artifact, [...(primaries.get(production.artifact) ?? []), executor.id]);
      }
    }
    const problems: string[] = [];
    for (const fileName of KNOWN_FILENAMES) {
      const producers = primaries.get(fileName) ?? [];
      if (lifecycle.has(fileName)) {
        if (producers.length > 0) {
          problems.push(`${fileName} is declared lifecycle-written but ${producers.join(", ")} claims it as primary`);
        }
        continue;
      }
      if (producers.length !== 1) {
        problems.push(`${fileName} has ${producers.length} primary producers [${producers.join(", ")}] — expected exactly 1`);
      }
    }
    // A lifecycle declaration also EXEMPTS its artifact from the seam test's
    // PARITY-2/PARITY-3 writability assertions, so a bogus entry would silence
    // them. It is only lifecycle-written if no executor source writes it.
    for (const entry of LIFECYCLE_PRODUCTIONS) {
      if (!entry.reason.trim()) {
        problems.push(`lifecycle entry ${entry.artifact} states no reason`);
      }
      if (!entry.writer.trim()) {
        problems.push(`lifecycle entry ${entry.artifact} names no writer`);
      }
      const writers = [...EXTRACTED]
        .filter(([, written]) => written.has(entry.artifact))
        .map(([id]) => id);
      if (writers.length > 0) {
        problems.push(
          `${entry.artifact} is declared lifecycle-written but ${writers.join(", ")} writes it`,
        );
      }
    }
    expect(problems.sort()).toEqual([]);
  });

  it("DECL-6: write-site data covers exactly the registry's executors, and dynamic contributors resolve", () => {
    const registryIds = sorted(EXECUTOR_REGISTRY.map((e) => e.id));
    const siteIds = sorted(EXECUTOR_WRITE_SITES.map((s) => s.executor));
    expect(
      siteIds,
      "EXECUTOR_WRITE_SITES must name every executor exactly once — an unmapped executor makes its pin vacuous.",
    ).toEqual(registryIds);

    const declaredByExecutor = new Map(
      EXECUTOR_REGISTRY.map((e) => [e.id, new Set(e.produces.map((p) => p.artifact))]),
    );
    const problems: string[] = [];
    for (const contributor of DYNAMIC_WRITE_CONTRIBUTORS) {
      const declared = declaredByExecutor.get(contributor.executor);
      if (!declared) {
        problems.push(`dynamic contributor names unknown executor ${contributor.executor}`);
        continue;
      }
      if (!declared.has(contributor.artifact)) {
        problems.push(
          `dynamic contributor ${contributor.executor} → ${contributor.artifact} is not declared by that executor`,
        );
      }
      if (!contributor.reason.trim()) {
        problems.push(`dynamic contributor ${contributor.executor} → ${contributor.artifact} states no reason`);
      }
    }
    expect(problems.sort()).toEqual([]);
  });

  it("DECL-7: a non-literal producer declaration REFUSES instead of rendering without it", () => {
    // The generator's header promises STRUCTURAL extraction because "a scanner
    // that silently drops what it does not understand is the shape this repo
    // bans". Fed a scratch source (never a mutation of the tracked registry),
    // both realistic non-literal forms must refuse: a concatenated note, and an
    // artifact named by the `*_FILENAME` constant the code already uses.
    const scratch = (produces: string) =>
      [
        "export const EXECUTOR_REGISTRY = [",
        '  { id: "scratch_executor", produces: [',
        `    { ${produces} },`,
        "  ] },",
        "];",
        "export const LIFECYCLE_PRODUCTIONS = [",
        '  { artifact: "audit_state.json", writer: "advanceAudit", reason: "lifecycle-written" },',
        "];",
        "",
      ].join("\n");

    // Control: the same shape with every initializer literal parses.
    expect(
      parseProducerDeclaration(scratch('artifact: "repo_manifest.json", role: "primary"')),
    ).toEqual({
      executors: [
        { id: "scratch_executor", produces: [{ artifact: "repo_manifest.json", role: "primary" }] },
      ],
      lifecycle: [
        { artifact: "audit_state.json", writer: "advanceAudit", reason: "lifecycle-written" },
      ],
    });

    expect(() =>
      parseProducerDeclaration(
        scratch('artifact: "graph_bundle.json", role: "refresh", note: "merges analyzer " + "edges"'),
      ),
    ).toThrow(/property "note" is not a string or array literal/);

    expect(() =>
      parseProducerDeclaration(scratch('artifact: AUDIT_REPORT_FILENAME, role: "primary"')),
    ).toThrow(/property "artifact" is not a string or array literal/);
  });

  it("DECL-8: the tracked producer table matches a fresh render of the declaration", () => {
    const tracked = readFileSync(resolve(REPO_ROOT, RENDER_FILE), "utf8");
    expect(
      tracked,
      `${RENDER_FILE} is stale — run node scripts/shared/generate-executor-producers.mjs`,
    ).toBe(renderProducerTable(readProducerDeclaration()));
  });

  it("DECL-9: every declaration array is in its documented content-derived order", () => {
    const problems: string[] = [];
    const pin = (label: string, keys: string[]) => {
      const ordered = [...keys].sort();
      if (JSON.stringify(keys) !== JSON.stringify(ordered)) {
        problems.push(`${label} is not in content-derived order (expected [${ordered.join(", ")}])`);
      }
    };
    for (const executor of EXECUTOR_REGISTRY) {
      pin(
        `${executor.id}.produces`,
        executor.produces.map((p) => `${p.artifact} ${p.role}`),
      );
    }
    pin(
      "LIFECYCLE_PRODUCTIONS",
      LIFECYCLE_PRODUCTIONS.map((entry) => entry.artifact),
    );
    pin(
      "EXECUTOR_WRITE_SITES",
      EXECUTOR_WRITE_SITES.map((site) => site.executor),
    );
    pin(
      "DYNAMIC_WRITE_CONTRIBUTORS",
      DYNAMIC_WRITE_CONTRIBUTORS.map((c) => `${c.executor} ${c.artifact}`),
    );
    expect(
      problems.sort(),
      "These arrays declare a stable content-derived order; an incidentally-ordered one churns " +
        "the rendered table's inputs on every re-authoring.",
    ).toEqual([]);
  });
});
