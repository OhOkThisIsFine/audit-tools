// Contract test for the shared-primitive single-source gate
// (scripts/check-shared-primitives.mjs, `npm run check:shared-primitives`).
// Pins the RULE MECHANICS on synthetic content — the gate itself runs over the
// tracked tree in verify:checks; this test is what makes each rule's matching
// semantics a contract rather than an implementation detail. Registered in
// scripts/guard-reach-data.mjs as `shared-primitives-gate-test`.
import { describe, expect, test } from "vitest";
import {
  PATTERN_RULES,
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
    const allGood = staleDataRows(
      new Set(PATTERN_RULES.flatMap((r) => r.exceptions.map((e) => e.file))),
    );
    expect(allGood).toEqual([]);
  });

  test("definitionRegex anchors on declaration syntax only", () => {
    const re = definitionRegex("toPosix");
    expect(re.test("function toPosix(p) {}")).toBe(true);
    expect(definitionRegex("toPosix").test("const toPosix = (p) => p;")).toBe(true);
    expect(definitionRegex("toPosix").test("toPosixPath(p)")).toBe(false);
  });
});
