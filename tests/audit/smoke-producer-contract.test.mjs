// The synthetic-result PRODUCER in `scripts/` must be held to the same contract
// as every other AuditResult construction site.
//
// `reviewed_clean` was added to the AuditResult contract with a `tests/**`
// fixture sweep. It went green four ways locally and failed release CI on this
// producer, because `scripts/` is covered by neither `tsconfig.json`
// (`include: ["src"]`) nor `tsconfig.test.json` (`include: ["src","tests"]`,
// and `checkJs: false` anyway) — so no typechecker sees it, and it hand-builds
// the contract without ever calling the validator that owns it.
//
// The rule currently lives as a COMMENT at the top of smoke-audit-flow.mjs
// telling the next author to sweep the whole repo. That is an
// instruction-to-remember, which is the class this repo enforces in tooling
// instead. The enforceable form is: the producer runs its own output through
// the real validator and refuses to emit a result the contract rejects — so a
// contract change breaks HERE, cheaply, instead of in a packaged smoke in CI.

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { buildSyntheticResults } = await import(
  "../../scripts/audit/smoke-audit-flow.mjs"
);
const { validateAuditResults } = await import(
  "../../src/audit/validation/auditResults.ts"
);

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "smoke-producer-"));
  try {
    await writeFile(join(root, "sample.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function task(overrides = {}) {
  return {
    task_id: "t1",
    unit_id: "u1",
    pass_id: "p1",
    lens: "correctness",
    file_paths: ["sample.ts"],
    ...overrides,
  };
}

describe("smoke synthetic-result producer", () => {
  it("emits results the real AuditResult validator accepts", async () => {
    await withRoot(async (root) => {
      const assigned = task();
      const results = await buildSyntheticResults([assigned], root, "linked");
      const errors = validateAuditResults(results, [assigned]).filter(
        (issue) => issue.severity === "error",
      );
      expect(errors).toEqual([]);
    });
  });

  // RED at HEAD: buildSyntheticResults hand-builds the payload and never calls
  // a validator, so it happily returns a result the contract rejects. This is
  // exactly the shape of the `reviewed_clean` miss — the producer cannot fail
  // on a contract it never consults.
  it("REFUSES to emit a result the contract rejects", async () => {
    await withRoot(async (root) => {
      // `lens` must match the assigned task; dropping it makes the produced
      // result contract-invalid, which the validator reports as an error.
      const assigned = task({ lens: undefined });

      // Precondition, established WITHOUT the producer (which now refuses this
      // payload): the shape this task yields really is contract-invalid, so the
      // rejection below is the validator firing and not an unrelated throw.
      const handBuilt = [
        {
          task_id: assigned.task_id,
          unit_id: assigned.unit_id,
          pass_id: assigned.pass_id,
          lens: undefined,
          agent_role: "smoke-reviewer",
          file_coverage: [{ path: "sample.ts", total_lines: 2 }],
          findings: [],
          reviewed_clean: true,
          notes: ["precondition"],
          requires_followup: false,
        },
      ];
      const errors = validateAuditResults(handBuilt, [assigned]).filter(
        (issue) => issue.severity === "error",
      );
      assert.ok(
        errors.length > 0,
        "precondition: this task shape must be contract-invalid",
      );

      await assert.rejects(
        () => buildSyntheticResults([assigned], root, "linked"),
        /contract-invalid/,
        "the producer must validate its own output instead of emitting an invalid AuditResult",
      );
    });
  });

  // The docblock at the top of smoke-audit-flow.mjs asserts it is the ONLY
  // AuditResult construction site in `scripts/`. That claim was true and
  // unchecked — which is how the second producer got missed in the first place
  // (there were two, in smoke-{packaged,linked}-audit-code.mjs, before they were
  // merged). A prose claim about coverage is exactly the thing this repo moves
  // into tooling, so the claim is a gate now.
  it("stays the ONLY AuditResult construction site in scripts/", async () => {
    const scriptsRoot = fileURLToPath(new URL("../../scripts/", import.meta.url));

    async function* walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
        } else if (/\.(mjs|js|ts)$/.test(entry.name)) {
          yield full;
        }
      }
    }

    const producers = [];
    for await (const file of walk(scriptsRoot)) {
      const source = await readFile(file, "utf8");
      // `file_coverage` is a required AuditResult field with no other use, so a
      // file that names it is building (or asserting on) the contract.
      if (source.includes("file_coverage")) {
        producers.push(relative(scriptsRoot, file).split(sep).join("/"));
      }
    }

    expect(producers).toEqual(["audit/smoke-audit-flow.mjs"]);
  });
});
