/**
 * Precision pins for the `check:version-gates` scan.
 *
 * The gate reports a schema version that is stamped into persisted state and
 * never compared when that state is read back. Its whole value depends on a RED
 * always being real: in this repo a false RED is as corrosive as a false green,
 * because a gate that cries wolf gets bypassed and then the true defect rides
 * in behind it. So the properties pinned here are mostly NEGATIVE — the shapes
 * that must NOT be reported — plus the one positive shape that recurred twice
 * (`readTestPlanCarry` / `readReviewSnapshot`).
 *
 * The scan is exercised over synthetic sources rather than the live tree, so
 * these stay meaningful while pre-existing violations are still being worked
 * off, and they pin the RULE rather than today's count.
 */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-version-gates.mjs");

const {
  scanVersionGates,
  findVersionConstants,
  findPayloadTypes,
  resolveConstant,
  typeNameIsUnique,
  enclosingCallee,
} = await import(SCRIPT);

const sourcesOf = (entries) => new Map(Object.entries(entries));
const names = (records) => records.map((r) => r.decl.name).sort();

/** A module that stamps a version on write and casts on read — the defect. */
const UNCHECKED_MODULE = `
const CARRY_SCHEMA_VERSION = "pipeline/carry/v1" as const;

interface Carry {
  schema_version: typeof CARRY_SCHEMA_VERSION;
  specs: Record<string, string>;
}

export async function writeCarry(dir: string): Promise<void> {
  await writeJsonFile(carryPath(dir), {
    schema_version: CARRY_SCHEMA_VERSION,
    specs: {},
  });
}

export async function readCarry(dir: string) {
  const carry = await readOptionalJsonFile<Carry>(carryPath(dir));
  return carry?.specs ?? {};
}
`;

describe("version-gate scan reports the unchecked read", () => {
  it("flags a payload that is stamped on write and cast on read", () => {
    const { violations } = scanVersionGates(sourcesOf({ "src/carry.ts": UNCHECKED_MODULE }));
    expect(names(violations)).toEqual(["CARRY_SCHEMA_VERSION"]);
    expect(violations[0].typeName).toBe("Carry");
    expect(violations[0].reads).toHaveLength(1);
    expect(violations[0].reads[0].file).toBe("src/carry.ts");
  });

  it("reports every read-back site, so the fix has nowhere to hide", () => {
    const twoReads = UNCHECKED_MODULE.replace(
      "export async function readCarry",
      `export async function peekCarry(dir: string) {
  return await readOptionalJsonFile<Carry>(carryPath(dir));
}

export async function readCarry`,
    );
    const { violations } = scanVersionGates(sourcesOf({ "src/carry.ts": twoReads }));
    expect(violations[0].reads).toHaveLength(2);
  });
});

describe("version-gate scan does not report a checked read", () => {
  it("accepts a direct comparison", () => {
    const checked = UNCHECKED_MODULE.replace(
      "return carry?.specs ?? {};",
      `if (carry?.schema_version !== CARRY_SCHEMA_VERSION) return {};
  return carry.specs;`,
    );
    const { violations, gated } = scanVersionGates(sourcesOf({ "src/carry.ts": checked }));
    expect(violations).toEqual([]);
    expect(names(gated)).toEqual(["CARRY_SCHEMA_VERSION"]);
  });

  it("accepts the shared pair, whose call nests parens across lines", () => {
    // The exact spelling the fix produces. A callee regex that forbids
    // intervening parens misses it and keeps REDding a file that is correct.
    const checked = UNCHECKED_MODULE.replace(
      "const carry = await readOptionalJsonFile<Carry>(carryPath(dir));",
      `const carry = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<Carry>(carryPath(dir)),
    CARRY_SCHEMA_VERSION,
  );`,
    );
    const { violations, gated } = scanVersionGates(sourcesOf({ "src/carry.ts": checked }));
    expect(violations).toEqual([]);
    expect(gated[0].checks[0].how).toMatch(/discardOnSchemaVersionMismatch/);
  });

  it("accepts a check written against a duplicated string literal in another module", () => {
    // `KNOWN_SCHEMA_VERSIONS` in intakeResolver.ts is this shape: the read IS
    // guarded, just not through the constant's identifier.
    const validator = `
const KNOWN_SCHEMA_VERSIONS = new Set([
  "pipeline/carry/v1",
]);
export function accepts(v: string): boolean {
  return KNOWN_SCHEMA_VERSIONS.has(v);
}
`;
    const { violations } = scanVersionGates(
      sourcesOf({ "src/carry.ts": UNCHECKED_MODULE, "src/validate.ts": validator }),
    );
    expect(violations).toEqual([]);
  });
});

describe("version-gate scan stays off shapes that are not the defect", () => {
  it("ignores a version emitted in an envelope that is never read back", () => {
    // A contract version stamped onto CLI output the host consumes: nothing in
    // this process ever reinterprets it, so demanding a check would be noise.
    const envelope = `
export const ENVELOPE_CONTRACT_VERSION = "tool/envelope/v1";
export interface Envelope {
  contract_version: typeof ENVELOPE_CONTRACT_VERSION;
  payload: unknown;
}
export function buildEnvelope(payload: unknown): Envelope {
  return { contract_version: ENVELOPE_CONTRACT_VERSION, payload };
}
`;
    const { violations, gated } = scanVersionGates(sourcesOf({ "src/envelope.ts": envelope }));
    expect(violations).toEqual([]);
    expect(gated).toEqual([]);
  });

  it("ignores a version constant that never reaches a persisted payload type", () => {
    const toolVersion = `
const GITLEAKS_VERSION = "8.21.2";
export const candidate = { name: "gitleaks", version: GITLEAKS_VERSION };
`;
    const { violations } = scanVersionGates(sourcesOf({ "src/tools.ts": toolVersion }));
    expect(violations).toEqual([]);
  });
});

describe("constant resolution is module-scoped", () => {
  const decls = findVersionConstants(
    sourcesOf({
      "src/a.ts": `const SNAPSHOT_SCHEMA_VERSION = "a/v1";`,
      "src/b.ts": `const SNAPSHOT_SCHEMA_VERSION = "b/v1";`,
      "src/c.ts": `export const SHARED_VERSION = "c/v1";`,
    }),
  );

  it("finds each same-named private constant separately", () => {
    expect(decls.filter((d) => d.name === "SNAPSHOT_SCHEMA_VERSION")).toHaveLength(2);
  });

  it("resolves a private constant to its own module, never the other module's", () => {
    expect(resolveConstant(decls, "SNAPSHOT_SCHEMA_VERSION", "src/a.ts").value).toBe("a/v1");
    expect(resolveConstant(decls, "SNAPSHOT_SCHEMA_VERSION", "src/b.ts").value).toBe("b/v1");
  });

  it("resolves an imported constant to the unique exported declaration", () => {
    expect(resolveConstant(decls, "SHARED_VERSION", "src/elsewhere.ts").value).toBe("c/v1");
  });

  it("refuses to attribute an ambiguous name from a third module (never a RED)", () => {
    expect(resolveConstant(decls, "SNAPSHOT_SCHEMA_VERSION", "src/z.ts")).toBeUndefined();
  });

  it("keeps two same-named private constants apart end to end", () => {
    // Both modules carry the identical defect; a name-keyed scan would report
    // one and silently drop the other.
    const { violations } = scanVersionGates(
      sourcesOf({
        "src/one.ts": UNCHECKED_MODULE.replace(/Carry/g, "OneSnap"),
        "src/two.ts": UNCHECKED_MODULE.replace(/Carry/g, "TwoSnap"),
      }),
    );
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.decl.file)).toEqual(["src/one.ts", "src/two.ts"]);
  });
});

describe("supporting predicates", () => {
  it("counts type declarations, not the modules that import the type", () => {
    const sources = sourcesOf({
      "src/decl.ts": "export interface ReviewRequest {\n  id: string;\n}\n",
      "src/use.ts": "import {\n  type ReviewRequest,\n} from './decl.js';\n",
    });
    expect(typeNameIsUnique(sources, "ReviewRequest")).toBe(true);
  });

  it("treats a genuinely duplicated type name as untraceable", () => {
    const sources = sourcesOf({
      "src/a.ts": "export interface Snap {\n  id: string;\n}\n",
      "src/b.ts": "interface Snap {\n  id: number;\n}\n",
    });
    expect(typeNameIsUnique(sources, "Snap")).toBe(false);
  });

  it("finds the enclosing callee across nested parens and newlines", () => {
    const src = "guardVersion(\n  await read<T>(pathFor(dir)),\n  CONST,\n);";
    expect(enclosingCallee(src, src.indexOf("CONST"))).toBe("guardVersion");
  });

  it("returns no callee for a position that is not a call argument", () => {
    const src = "const record = {\n  schema_version: CONST,\n};";
    expect(enclosingCallee(src, src.indexOf("CONST"))).toBeUndefined();
  });

  it("reads the version key off the payload type declaration", () => {
    const payloads = findPayloadTypes(sourcesOf({ "src/carry.ts": UNCHECKED_MODULE }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      typeName: "Carry",
      constName: "CARRY_SCHEMA_VERSION",
      versionKey: "schema_version",
    });
  });
});
