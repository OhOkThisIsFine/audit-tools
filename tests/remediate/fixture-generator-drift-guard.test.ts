/**
 * Drift guard: runs the real auditor-contract fixture generator into a temp dir
 * and byte-compares its raw UTF-8 output against the committed fixture.
 *
 * Obligations: OBL-FDG-M, OBL-FDG-01, OBL-FDG-02, OBL-FDG-03, OBL-SEAM-06
 *
 * Contract:
 *   - NEVER overwrites the committed fixture (generator is redirected via argv).
 *   - Raw-string equality (not parsed/re-serialized) — detects key-order, whitespace, or newline drift.
 *   - Targeted sub-assertion on contract_version field.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileHidden } from "../helpers/spawn.mjs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..", "..");
const COMMITTED_FIXTURE = join(
  PACKAGE_ROOT,
  "tests",
  "remediate",
  "fixtures",
  "auditor-contract-audit-findings.json",
);
const GENERATOR_SCRIPT = join(
  PACKAGE_ROOT,
  "scripts",
  "remediate",
  "generate-auditor-contract-fixture.mjs",
);

/**
 * Promise wrapper over the window-hidden `execFile` helper. Written out rather
 * than `promisify`d because the helper is untyped JS, so `promisify` cannot
 * recover its `(file, args, options, callback)` arity from the inferred type.
 * Rejects on a non-zero exit exactly as `promisify(execFile)` did.
 */
function runGenerator(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileHidden(
      process.execPath,
      [GENERATOR_SCRIPT, outPath],
      { cwd: PACKAGE_ROOT },
      (error: Error | null) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("auditor-contract fixture drift guard", () => {
  it("generator output matches the committed fixture byte-for-byte (raw UTF-8 string equality)", async () => {
    // Create a temp dir; pass the output path as argv[2] so the committed fixture is never touched.
    tempDir = await mkdtemp(join(tmpdir(), "fixture-drift-guard-"));
    const tempOut = join(tempDir, "auditor-contract-audit-findings.json");

    // Run the real generator, redirecting output to temp.
    await runGenerator(tempOut);

    // Read both as raw UTF-8 strings — no JSON.parse, no re-serialization.
    const generated = await readFile(tempOut, "utf8");
    const committed = await readFile(COMMITTED_FIXTURE, "utf8");

    // Byte-for-byte equality — catches key-order, whitespace, newline drift.
    expect(generated).toBe(committed);
  });

  it("generated output contains the expected contract_version value", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fixture-drift-guard-version-"));
    const tempOut = join(tempDir, "auditor-contract-audit-findings.json");

    await runGenerator(tempOut);

    const generated = await readFile(tempOut, "utf8");
    const parsed: unknown = JSON.parse(generated);

    expect(parsed).toMatchObject({
      contract_version: "audit-tools/audit-findings/v1alpha1",
    });
  });

  it("committed fixture is unchanged after running the generator (clobber guard)", async () => {
    // Read the committed fixture BEFORE running the generator.
    const before = await readFile(COMMITTED_FIXTURE, "utf8");

    tempDir = await mkdtemp(join(tmpdir(), "fixture-drift-guard-clobber-"));
    const tempOut = join(tempDir, "auditor-contract-audit-findings.json");

    // Generator writes to tempOut, NOT the committed path.
    await runGenerator(tempOut);

    // The committed fixture must be byte-identical to what it was before the run.
    const after = await readFile(COMMITTED_FIXTURE, "utf8");
    expect(after).toBe(before);
  });
});
