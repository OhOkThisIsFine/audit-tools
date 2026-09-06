// P56 — every tracked GENERATED artifact is reconciled against a declared
// freshness authority, the way check:guard-reach already reconciles guards.
//
// CANDIDATE FILE. Its landing location is tests/shared/ — vitest excludes
// .claude/**, and a test that lives beside its subject in the proposals tree
// never runs, so a test authored anywhere else is a test nobody runs.
//
// The defect class: a generator writes a TRACKED artifact, and whether anything
// makes that artifact's staleness RED is decided one generator at a time, by
// whoever happened to wire a `--check`. Eleven generators are wired; four are
// not, and the repo cannot tell you which without a hand survey. Two of the
// four are deliberate; two are not, and one of those (docs/nightly-inbox.md)
// caused confirmed same-day damage — four settled propositions re-put to the
// owner from a stale render.
//
// The mechanism this test pins: a `GENERATED` section in the guard-reach
// registry, one row per tracked generated artifact, each naming its generator
// and exactly one freshness authority:
//   authority: 'check'        — a `check:*` npm script that runs the generator's
//                               --check arm, AND is inside verify:checks.
//   authority: 'contractTest' — a tracked test under tests/ that re-runs the
//                               extraction and diffs it against the render.
//   onDemand: true            — deliberately gated by nothing, with a stated
//                               `reason`. A gap is a decision; silence is a
//                               defect. This is the registry's own
//                               'declared-gap' rule applied to derived files.
//
// Bidirectional, like check:guard-reach: a generator in the tree that no row
// claims is red, and a row naming an authority that does not exist is red.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import * as registry from "../../scripts/guard-reach-data.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tracked generator scripts: scripts/**\/generate-*.mjs plus the nightly renderer. */
function trackedGenerators(): string[] {
  const out = execFileSyncHidden("git", ["ls-files", "-z", "scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return String(out)
    .split("\0")
    .filter(Boolean)
    .filter((p) => /(^|\/)(generate-[^/]+|render-inbox)\.mjs$/.test(p))
    .sort();
}

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("generated-artifact freshness registry", () => {
  it("the guard-reach registry declares a GENERATED section", () => {
    // RED AT HEAD: no such export exists. This is the mechanism being absent,
    // which is exactly what the proposal adds. Every assertion below is
    // downstream of it and becomes live once the section lands.
    expect(Object.keys(registry)).toContain("GENERATED");
  });

  it("every tracked generator is claimed by exactly one row", () => {
    const rows = (registry as { GENERATED?: Array<{ generator: string }> }).GENERATED ?? [];
    const claimed = new Set(rows.map((r) => r.generator));
    const unclaimed = trackedGenerators().filter((g) => !claimed.has(g));
    expect(unclaimed, `generators claimed by no GENERATED row: ${unclaimed.join(", ")}`).toEqual(
      [],
    );

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.generator, (counts.get(r.generator) ?? 0) + 1);
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([g]) => g);
    expect(duplicated, "a generator claimed twice has two answers about its authority").toEqual(
      [],
    );
  });

  it("every row names a freshness authority that actually exists", () => {
    const rows =
      (
        registry as {
          GENERATED?: Array<{
            generator: string;
            artifacts?: string[];
            authority?: "check" | "contractTest";
            npmScript?: string;
            contractTest?: string;
            onDemand?: boolean;
            reason?: string;
          }>;
        }
      ).GENERATED ?? [];
    expect(rows.length, "an empty section would pass vacuously").toBeGreaterThan(0);

    const scripts = packageScripts();
    const verifyChecks = scripts["verify:checks"] ?? "";

    for (const row of rows) {
      if (row.onDemand === true) {
        // A declared gap must SAY why, or it is silence wearing a field name.
        expect(
          (row.reason ?? "").trim().length,
          `${row.generator}: onDemand with no stated reason`,
        ).toBeGreaterThan(0);
        expect(row.authority, `${row.generator}: onDemand row also claims an authority`).toBe(
          undefined,
        );
        continue;
      }

      if (row.authority === "check") {
        const name = row.npmScript ?? "";
        expect(scripts[name], `${row.generator}: npm script ${name} does not exist`).toBeTruthy();
        expect(
          scripts[name],
          `${row.generator}: ${name} does not run the generator's --check arm`,
        ).toContain("--check");
        expect(
          verifyChecks.split(/\s+/),
          `${row.generator}: ${name} is not inside verify:checks — a check in no gate is not a gate`,
        ).toContain(name);
        continue;
      }

      if (row.authority === "contractTest") {
        const path = row.contractTest ?? "";
        expect(path.startsWith("tests/"), `${row.generator}: ${path} is outside tests/`).toBe(true);
        expect(existsSync(join(ROOT, path)), `${row.generator}: ${path} does not exist`).toBe(true);
        continue;
      }

      expect.fail(
        `${row.generator}: no authority — expected 'check', 'contractTest', or onDemand:true`,
      );
    }
  });

  it("every declared artifact is a tracked file", () => {
    const rows =
      (registry as { GENERATED?: Array<{ generator: string; artifacts?: string[] }> }).GENERATED ??
      [];
    const tracked = new Set(
      String(execFileSyncHidden("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }))
        .split("\0")
        .filter(Boolean),
    );
    for (const row of rows) {
      for (const artifact of row.artifacts ?? []) {
        expect(tracked.has(artifact), `${row.generator}: ${artifact} is not tracked`).toBe(true);
      }
    }
  });
});
