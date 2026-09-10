// Contract test for the shared-primitive single-source gate
// (scripts/check-shared-primitives.mjs, `npm run check:shared-primitives`).
// Pins the RULE MECHANICS on synthetic content — the gate itself runs over the
// tracked tree in verify:checks; this test is what makes each rule's matching
// semantics a contract rather than an implementation detail. Registered in
// scripts/guard-reach-data.mjs as `shared-primitives-gate-test`.
import { describe, expect, test } from "vitest";
import {
  PATTERN_DATA_SOURCES,
  PATTERN_RULES,
  SCAN_PATHSPECS,
  SINGLE_DEFINITION_RULES,
  definitionRegex,
  scanFile,
  staleDataRows,
} from "../../scripts/check-shared-primitives.mjs";

function ruleById(id: string) {
  const rule = PATTERN_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`missing pattern rule ${id}`);
  return rule;
}

describe("single-definition rules", () => {
  test("a second definition outside the home is a violation (function and const forms)", () => {
    const hits = scanFile(
      "src/audit/somewhere.ts",
      [
        "function isRecord(value: unknown) { return false; }",
        "const compareCodeUnits = (a: string, b: string) => 0;",
      ].join("\n"),
    );
    const rules = hits.map((h) => h.rule);
    expect(rules).toContain("single-definition:isRecord");
    expect(rules).toContain("single-definition:compareCodeUnits");
  });

  test("the declared home is exempt", () => {
    const home = SINGLE_DEFINITION_RULES.find((r) => r.name === "isRecord");
    expect(home?.home).toBe("src/shared/validation/basic.ts");
    const hits = scanFile(
      "src/shared/validation/basic.ts",
      "export function isRecord(value: unknown) { return true; }",
    );
    expect(hits.filter((h) => h.rule === "single-definition:isRecord")).toEqual([]);
  });

  test("a retired fork name is banned outright (home: null)", () => {
    const hits = scanFile(
      "src/remediate/x.ts",
      "function isOutsideRoot(root: string, c: string) { return false; }",
    );
    expect(hits.some((h) => h.rule === "single-definition:isOutsideRoot")).toBe(true);
    expect(hits[0]?.detail).toContain("retired fork name");
  });

  test("a mere CALL of a governed name is not a definition", () => {
    const hits = scanFile("src/audit/y.ts", "const x = isRecord(value);\nhashContent(v);\n");
    expect(hits.filter((h) => h.rule.startsWith("single-definition:"))).toEqual([]);
  });

  test("a type-annotated const re-roll is still a definition", () => {
    const hits = scanFile(
      "src/audit/y.ts",
      "const isRecord: (v: unknown) => boolean = (v) => typeof v === \"object\";",
    );
    expect(hits.some((h) => h.rule === "single-definition:isRecord")).toBe(true);
  });
});

describe("comparator-body pattern", () => {
  const rule = ruleById("comparator-body");

  test("matches the code-unit comparator body with any identifiers, spacing, and property chains", () => {
    for (const body of [
      "left < right ? -1 : left > right ? 1 : 0",
      "a<b?-1:a>b?1:0",
      "x.id < y.id ? -1 : x.id > y.id ? 1 : 0",
    ]) {
      expect(scanFile("src/z.ts", body).some((h) => h.rule === "comparator-body"), body).toBe(true);
    }
  });

  test("does NOT match a ternary whose identifiers do not repeat (backreference discipline)", () => {
    const hits = scanFile("src/z.ts", "a < b ? -1 : c > d ? 1 : 0");
    expect(hits.filter((h) => h.rule === "comparator-body")).toEqual([]);
  });

  test("the home file is exempt", () => {
    expect(rule.homes).toContain("src/shared/compareCodeUnits.ts");
    const hits = scanFile(
      "src/shared/compareCodeUnits.ts",
      "return left < right ? -1 : left > right ? 1 : 0;",
    );
    expect(hits.filter((h) => h.rule === "comparator-body")).toEqual([]);
  });
});

describe("containment-predicate pattern", () => {
  test("fires only when relative( and a ..-prefix startsWith test share a file", () => {
    const both = 'const rel = relative(a, b);\nif (rel.startsWith("..")) return null;';
    expect(scanFile("src/q.ts", both).some((h) => h.rule === "containment-predicate")).toBe(true);
    const startsWithOnly = 'if (name.startsWith("..")) skip();';
    expect(
      scanFile("src/q.ts", startsWithOnly).filter((h) => h.rule === "containment-predicate"),
    ).toEqual([]);
  });
});

describe("sha256-chain pattern", () => {
  test('fires on createHash("sha256") in any quote style, not on sha1', () => {
    expect(
      scanFile("src/h.ts", 'createHash("sha256").update(x).digest("hex")').some(
        (h) => h.rule === "sha256-chain",
      ),
    ).toBe(true);
    expect(
      scanFile("src/h.ts", "createHash('sha256')").some((h) => h.rule === "sha256-chain"),
    ).toBe(true);
    expect(
      scanFile("src/h.ts", 'createHash("sha1").update(x)').filter((h) => h.rule === "sha256-chain"),
    ).toEqual([]);
  });

  test("the declared exception file is exempt and must stay tracked", () => {
    const rule = ruleById("sha256-chain");
    expect(rule.exceptions.map((e) => e.file)).toContain("src/audit/io/toolingManifest.ts");
    expect(
      scanFile("src/audit/io/toolingManifest.ts", 'createHash("sha256")').filter(
        (h) => h.rule === "sha256-chain",
      ),
    ).toEqual([]);
  });
});

describe("hash-chain-truncated pattern", () => {
  // The two refuted re-rolls this rule exists for, verbatim shapes: the
  // one-line sha1 helper body and the multi-line chained form. The banned
  // thing is the CONSTRUCTION (inline createHash chain + bare slice literal),
  // whatever the algorithm.
  test("fires on a one-line sha1 chain truncated by a bare slice", () => {
    expect(
      scanFile(
        "src/audit/somewhere.ts",
        'return createHash("sha1").update(value).digest("hex").slice(0, 10);',
      ).some((h) => h.rule === "hash-chain-truncated"),
    ).toBe(true);
  });

  test("fires on a multi-line chain, any algorithm", () => {
    const content = [
      'const hash = createHash("md5")',
      "  .update(parts.join(joiner))",
      '  .digest("hex")',
      "  .slice(0, 12);",
    ].join("\n");
    expect(
      scanFile("src/audit/somewhere.ts", content).some(
        (h) => h.rule === "hash-chain-truncated",
      ),
    ).toBe(true);
  });

  test("does NOT fire on a broken chain with a variable slice length (hashContent's own body shape)", () => {
    const content = [
      'const digest = createHash("sha256").update(content, "utf8").digest("hex");',
      "if (length === undefined) return digest;",
      "return digest.slice(0, length);",
    ].join("\n");
    expect(
      scanFile("src/other.ts", content).filter(
        (h) => h.rule === "hash-chain-truncated",
      ),
    ).toEqual([]);
  });

  test("does NOT fire on an untruncated full-digest chain", () => {
    expect(
      scanFile(
        "src/other.ts",
        'createHash("sha1").update(x).digest("hex")',
      ).filter((h) => h.rule === "hash-chain-truncated"),
    ).toEqual([]);
  });

  test("the hash home is exempt", () => {
    expect(
      scanFile(
        "src/shared/hash.ts",
        'createHash("sha1").update(x).digest("hex").slice(0, 8)',
      ).filter((h) => h.rule === "hash-chain-truncated"),
    ).toEqual([]);
  });
});

describe("intl-collator pattern", () => {
  test("the other ICU spelling is banned too", () => {
    expect(
      scanFile("src/s.ts", "arr.sort(new Intl.Collator().compare);").some(
        (h) => h.rule === "intl-collator",
      ),
    ).toBe(true);
  });
});

describe("locale-compare pattern", () => {
  test("fires on a call and on the bare token in a comment; src-wide (no homes)", () => {
    expect(ruleById("locale-compare").homes).toEqual([]);
    expect(
      scanFile("src/s.ts", "arr.sort((a, b) => a.localeCompare(b));").some(
        (h) => h.rule === "locale-compare",
      ),
    ).toBe(true);
    expect(
      scanFile("src/s.ts", "// never localeCompare here").some((h) => h.rule === "locale-compare"),
    ).toBe(true);
  });
});

describe("data hygiene", () => {
  test("an exception naming a file that is not tracked is itself a violation (self-cleaning)", () => {
    const tracked = new Set(["src/shared/hash.ts"]);
    const stale = staleDataRows(tracked);
    expect(stale.some((v) => v.detail.includes("src/audit/io/toolingManifest.ts"))).toBe(true);
  });

  test("a declared home missing from the tracked set is a violation (rule cannot go vacuous)", () => {
    const withoutBasic = new Set(
      [
        ...SINGLE_DEFINITION_RULES.flatMap((r) => (Array.isArray(r.home) ? r.home : r.home === null ? [] : [r.home])),
        ...PATTERN_RULES.flatMap((r) => [...r.homes, ...r.exceptions.map((e) => e.file)]),
        ...PATTERN_DATA_SOURCES.map((r) => r.file),
      ].filter((f) => f !== "src/shared/validation/basic.ts"),
    );
    const stale = staleDataRows(withoutBasic);
    expect(stale.some((v) => v.rule === "single-definition:isRecord:missing-home")).toBe(true);
    expect(staleDataRows(new Set([...withoutBasic, "src/shared/validation/basic.ts"]))).toEqual(
      [],
    );
  });

  test("a pattern data source that leaves the scanned set is a violation (the exemption self-cleans)", () => {
    // An exemption whose file is gone would silently widen the exemption set to
    // nothing — the same rot every other row here is protected against.
    const withoutDataSource = new Set(
      [
        ...SINGLE_DEFINITION_RULES.flatMap((r) => (Array.isArray(r.home) ? r.home : r.home === null ? [] : [r.home])),
        ...PATTERN_RULES.flatMap((r) => [...r.homes, ...r.exceptions.map((e) => e.file)]),
        ...PATTERN_DATA_SOURCES.map((r) => r.file),
      ].filter((f) => f !== "scripts/guard-reach-data.mjs"),
    );
    const stale = staleDataRows(withoutDataSource);
    expect(
      stale.some((v) => v.rule === "pattern-data-source:stale-row" && v.detail.includes("guard-reach-data.mjs")),
    ).toBe(true);
  });

  test("definitionRegex anchors on declaration syntax only", () => {
    const re = definitionRegex("toPosix");
    expect(re.test("function toPosix(p) {}")).toBe(true);
    expect(definitionRegex("toPosix").test("const toPosix = (p) => p;")).toBe(true);
    expect(definitionRegex("toPosix").test("toPosixPath(p)")).toBe(false);
  });
});

describe("scan reach — the enforcement layer is no longer the one tree exempt", () => {
  test("the scan set reaches the governance tree, not src/ alone (ceremony review 2026-08-29, F1)", () => {
    // The defect: `git ls-files 'src/**/*.ts'` was the whole scan set, so the
    // repository's own one-definition-per-primitive gate did not apply to the
    // tree that ENFORCES it. That is why the generated-artifact pattern was
    // written fifteen times and the anti-duplication rule stated seven times.
    const joined = SCAN_PATHSPECS.join(" ");
    expect(joined).toContain("scripts/");
    expect(joined).toContain(".claude/hooks/");
    expect(joined).toContain("wrapper/");
    expect(joined).toContain("dispatch/");
  });

  test("both levels of each tree are named — `**/` requires an intervening directory", () => {
    // The trap: `scripts/**/*.mjs` omits `scripts/*.mjs`, so every top-level
    // check script (including this gate's own) was outside the scan while the
    // pathspec LOOKED like it covered the tree.
    for (const tree of ["scripts/", "wrapper/", "dispatch/"]) {
      expect(SCAN_PATHSPECS, `${tree} top level`).toContain(`${tree}*.mjs`);
      expect(SCAN_PATHSPECS, `${tree} nested`).toContain(`${tree}**/*.mjs`);
    }
    // A bare `*.mjs` would match at EVERY depth (git pathspecs let `*` cross
    // `/`) and sweep in .audit-tools/ and the test fixtures.
    expect(SCAN_PATHSPECS).not.toContain("*.mjs");
  });

  test("the pre-build primitive twin is a declared home, so it is not a re-roll", () => {
    // The governance tree cannot import audit-tools/shared (pre-build), so the
    // twins in scripts/shared/primitives.mjs are the second home — declared, not
    // exempted. A rule naming only the src home would flag the twin.
    for (const name of ["compareCodeUnits", "hashContent", "resolveWithinRoot"]) {
      const rule = SINGLE_DEFINITION_RULES.find((r) => r.name === name);
      expect(rule?.home, `${name} must declare BOTH homes`).toEqual(
        expect.arrayContaining(["scripts/shared/primitives.mjs"]),
      );
    }
  });

  test("a rule data source is exempt from EVERY rule, so the declaration can spell what it bans", () => {
    // A rule table must be able to write the banned regex and a positive sample
    // verbatim; a form registry must carry samples the recognizer flags.
    for (const row of PATTERN_DATA_SOURCES) {
      const declared = scanFile(row.file, "function isPlainObject(v) { return v; }\nconst cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;\nnames.sort((a, b) => a.localeCompare(b));\n");
      expect(declared, `${row.file} must be exempt`).toEqual([]);
    }
    // ...and the exemption is scoped to those rows: an ordinary file with the
    // same content is still a violation.
    expect(scanFile("scripts/some-other.mjs", "names.sort((a, b) => a.localeCompare(b));\n").length).toBeGreaterThan(0);
  });
});
