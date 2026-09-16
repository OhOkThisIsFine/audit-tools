// The repository's LANDING GATES — the tree-wide guard suites and cheap release
// gates every landing must run — as DECLARED DATA discovered from the target
// repository, never a mechanism baked into this package.
//
// THE DEFECT THIS PINS (docs/backlog/open-bugs.md, "The per-item required tests
// and the host landing gate do not include the tree-wide guard suites or the
// cheap release gates"): three remediation landings reddened CI after green
// per-item runs — a hand-restated `.audit-tools` literal caught only by
// `tests/shared/audit-tools-path-guard.test.ts`, a case-folding assertion true
// only on a case-insensitive volume, and an intra-`src/shared` import cycle the
// reviewer graded minor that `check:depgraph` refuses. The per-item required
// tests were the block's `targeted_commands`, which are module-scoped: nothing
// in the run ever asked for the tree-wide gates CI runs.
//
// WHERE THE GATES RUN is the CLOSE, on the merged tree — not a per-item
// `required_tests` entry. These are facts about the WHOLE tree, so a wave item
// whose added export has no consumer until a LATER item lands cannot satisfy
// them; folding them into each item refused exactly that item and let one
// item's fault refuse another. See `verifyLandingGates` in
// `src/remediate/phases/closeVerifyLandingGates.ts` and CLAUDE.md, *A gate
// states the boundary it OWNS*. What stays per-item is the one SCOPE fact this
// module owns: a block that coins an invariant id needs the glossary document
// in its write scope (`withGlossaryScope`), or the gate is unsatisfiable for it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GLOSSARY_DOCUMENT_PATH,
  LANDING_GATE_SCRIPT_NAMES,
  declaresInvariantId,
  declaredInvariantIds,
  discoverLandingGates,
  withGlossaryScope,
} from "../../src/shared/tooling/landingGates.js";

const roots: string[] = [];

async function repoWithScripts(scripts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "landing-gates-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
  return root;
}

/**
 * A repo root carrying a glossary document with the given ids, one row each —
 * the shape `withGlossaryScope` reads. The document lives under `docs/`, so the
 * directory is created first: the fixture root is a bare tempdir.
 */
async function repoWithGlossary(ids: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "landing-glossary-"));
  roots.push(root);
  await mkdir(join(root, "docs"), { recursive: true });
  const rows = ids.map((id) => `| ${id} | something holds. | \`src/a.ts\` |`);
  await writeFile(
    join(root, ...GLOSSARY_DOCUMENT_PATH.split("/")),
    `# Glossary\n\n| Namespace | Contract | Live owner |\n|---|---|---|\n${rows.join("\n")}\n`,
    "utf8",
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("discoverLandingGates", () => {
  it("discovers the guard suite and the cheap release gates from a repository that declares them", async () => {
    const root = await repoWithScripts({
      test: "vitest run",
      "verify:guards": "node scripts/shared/run-vitest-gate.mjs",
      "verify:checks": "node scripts/shared/profile-run.mjs verify-checks",
      "check:depgraph": "depcruise --config .dependency-cruiser.cjs src",
      "check:deadcode": "knip --no-config-hints",
      "check:lint": "eslint .",
      "check:doc-links": "node scripts/check-doc-links.mjs",
    });

    // Content-sorted, so the emitted list is stable whatever order the
    // repository declared its scripts in.
    expect(discoverLandingGates(root)).toEqual([
      "npm run check:deadcode",
      "npm run check:depgraph",
      "npm run check:lint",
      "npm run verify:guards",
    ]);
  });

  it("carries the LANDING_GATE_SCRIPT_NAMES vocabulary, so a role is declared once", () => {
    // The vocabulary is DATA: the discovery rides it, and a role removed from
    // it stops being discovered. Asserting the shape here keeps the declared
    // list and the discovery from drifting apart silently.
    const roles = new Set(LANDING_GATE_SCRIPT_NAMES.map((entry) => entry.role));
    expect(roles).toEqual(new Set(["guard", "deadcode", "depgraph", "glossary", "lint"]));
  });

  it("omits a role the repository does not declare, rather than inventing a command", async () => {
    const root = await repoWithScripts({ test: "vitest run", "check:lint": "eslint ." });
    expect(discoverLandingGates(root)).toEqual(["npm run check:lint"]);
  });

  it("returns nothing for a repository with no package.json — degrade to empty, never throw", async () => {
    const root = await mkdtemp(join(tmpdir(), "landing-gates-empty-"));
    roots.push(root);
    expect(discoverLandingGates(root)).toEqual([]);
  });

  it("returns nothing for a malformed package.json rather than failing the prepare", async () => {
    const root = await mkdtemp(join(tmpdir(), "landing-gates-bad-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), "{ not json", "utf8");
    expect(discoverLandingGates(root)).toEqual([]);
  });

  it("emits the gates in a content-stable order, so a re-derivation cannot churn the digest", async () => {
    const a = await repoWithScripts({
      "check:lint": "eslint .",
      "check:depgraph": "depcruise src",
      "check:deadcode": "knip",
      "verify:guards": "node g.mjs",
    });
    const b = await repoWithScripts({
      "verify:guards": "node g.mjs",
      "check:deadcode": "knip",
      "check:depgraph": "depcruise src",
      "check:lint": "eslint .",
    });
    expect(discoverLandingGates(a)).toEqual(discoverLandingGates(b));
    expect(discoverLandingGates(a)).toEqual([...discoverLandingGates(a)].sort());
  });
});

describe("declaredInvariantIds", () => {
  it("finds every id nested anywhere in a contract, not only in a field called `invariants`", () => {
    expect([...declaredInvariantIds({ invariants: ["INV-ABC-ONE holds"] })]).toEqual([
      "INV-ABC-ONE",
    ]);
    expect([...declaredInvariantIds([{ nested: { deeper: "INV-ABC" } }])]).toEqual(["INV-ABC"]);
    // A producer that hangs the id on an obligation slug is just as much a
    // declaration as one that names an `invariants` field.
    expect([...declaredInvariantIds("satisfies INV-SSP-DEFERRED-SET-REPORTED")]).toEqual([
      "INV-SSP-DEFERRED-SET-REPORTED",
    ]);
  });

  it("collects EVERY id in one string — the lastIndex a global regex carries must not truncate the set", () => {
    // `/g` + `test()` would resume from lastIndex and skip the second id; the
    // caller subtracts this set from the documented ids, so a truncated set
    // reads a COINED id as already-documented and denies the widening.
    expect([
      ...declaredInvariantIds("INV-ALPHA holds, and INV-BETA holds too"),
    ]).toEqual(["INV-ALPHA", "INV-BETA"]);
  });

  it("does NOT read a lowercase test-family id or an id-less contract as a declaration", () => {
    // The gate scans `src/` for the PRODUCTION namespace only; a lowercase
    // test-family id is deliberately outside it, and so is a contract with no
    // id at all.
    expect(declaresInvariantId("INV-remediate-state-01")).toBe(false);
    expect(declaresInvariantId({ inputs: ["a path"], outputs: ["a string"] })).toBe(false);
    expect(declaresInvariantId(null)).toBe(false);
    expect(declaresInvariantId(7)).toBe(false);
  });
});

describe("withGlossaryScope", () => {
  it("adds the glossary document when the contract COINS an id the document does not carry", async () => {
    const root = await repoWithGlossary(["INV-EXISTING"]);
    // Content-sorted, matching `allowed_files`' own ordering.
    expect(
      withGlossaryScope(root, ["src/a.ts"], new Set(["INV-BRAND-NEW"])),
    ).toEqual([GLOSSARY_DOCUMENT_PATH, "src/a.ts"]);
  });

  it("does NOT widen for a contract that only MENTIONS an id the glossary already documents", async () => {
    // The H4 defect: `declaresInvariantId` widened on a MENTION, so a seam
    // adjustment citing `INV-EXISTING` — or any prose reference to it — handed
    // the item write scope over a document it had no business editing.
    const root = await repoWithGlossary(["INV-EXISTING"]);
    expect(
      withGlossaryScope(root, ["src/a.ts"], new Set(["INV-EXISTING"])),
    ).toEqual(["src/a.ts"]);
  });

  it("does NOT widen when the target root has no glossary document at all", async () => {
    // The H5 defect: `docs/glossary-ids.md` is THIS repository's convention, and
    // `remediate-code` runs against arbitrary repositories. Widening on the
    // NAME alone grants scope over a file the target does not have.
    const root = await mkdtemp(join(tmpdir(), "landing-no-glossary-"));
    roots.push(root);
    expect(withGlossaryScope(root, ["src/a.ts"], new Set(["INV-BRAND-NEW"]))).toEqual([
      "src/a.ts",
    ]);
  });

  it("leaves a scope that declares no id untouched — a blanket glossary write scope is not granted", async () => {
    const root = await repoWithGlossary(["INV-EXISTING"]);
    expect(withGlossaryScope(root, ["src/a.ts"], new Set())).toEqual(["src/a.ts"]);
  });

  it("widens for a contract mixing a documented id with a coined one — one coin is enough", async () => {
    const root = await repoWithGlossary(["INV-EXISTING"]);
    expect(
      withGlossaryScope(root, ["src/a.ts"], new Set(["INV-EXISTING", "INV-BRAND-NEW"])),
    ).toEqual([GLOSSARY_DOCUMENT_PATH, "src/a.ts"]);
  });

  it("is idempotent and stays content-sorted", async () => {
    const root = await repoWithGlossary(["INV-EXISTING"]);
    const declared = new Set(["INV-BRAND-NEW"]);
    const once = withGlossaryScope(root, ["src/a.ts"], declared);
    expect(withGlossaryScope(root, once, declared)).toEqual(once);
    expect(once).toEqual([...once].sort());
  });
});
