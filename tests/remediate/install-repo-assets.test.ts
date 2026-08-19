import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runValidateCommand } from "../../src/remediate/index.js";
import { rm, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");
const TEST_ROOT = scratchDir(".test-install-root");
const TEST_HOME = scratchDir(".test-install-home");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(TEST_HOME, { recursive: true, force: true });
});

describe("committed host-asset no-drift guard", () => {
  it("committed .agent/skills/remediate-code/SKILL.md matches canonical skills/remediate-code/SKILL.md", () => {
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    const installed = lf(
      readFileSync(join(PKG_ROOT, ".agent", "skills", "remediate-code", "SKILL.md"), "utf8"),
    );
    const canonical = lf(
      readFileSync(join(PKG_ROOT, "skills", "remediate-code", "SKILL.md"), "utf8"),
    );
    expect(
      installed,
      "Committed .agent/skills/remediate-code/SKILL.md drifted from the canonical skills/remediate-code/SKILL.md. Re-run `remediate-code install` (or regenerate the asset).",
    ).toBe(canonical);
  });
});

describe("runValidateCommand", () => {
  it("returns 0 when type checking succeeds", () => {
    const logs: string[] = [];
    const code = runValidateCommand({
      run: () => ({ status: 0 }) as any,
      log: (message) => logs.push(message),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(logs[0]).toMatch(/types OK/);
  });

  it("returns the child status when type checking fails", () => {
    const errors: string[] = [];
    const code = runValidateCommand({
      run: () => ({ status: 17 }) as any,
      log: () => {},
      error: (message) => errors.push(message),
    });

    expect(code).toBe(17);
    expect(errors[0]).toMatch(/Type check failed/);
  });
});
