// T44 / INV-remediate-tests-12 extended: a `vi.spyOn` on the `audit-tools/shared`
// re-export barrel passes VACUOUSLY (the spy records zero calls, so every
// assertion is green while exercising nothing). The detector was mechanically
// guarded ONLY under tests/remediate; tests/audit and tests/shared were verified
// by hand instead. This shared invariant scans ALL THREE areas, so a bad barrel
// spy fails wherever it lands. See tests/helpers/barrelSpy.ts for the detector
// and the allowed (built-in / relative-module) forms.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { barrelSpyViolations } from "../helpers/barrelSpy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..", "..");
const AREAS = ["audit", "shared", "remediate"];

describe("no test file spies on the audit-tools/shared re-export barrel (any area)", () => {
  it("scans every test area for a barrel-namespace spy", () => {
    const violations: string[] = [];
    for (const area of AREAS) {
      const dir = join(PACKAGE_ROOT, "tests", area);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".test.ts") && !file.endsWith(".test.mjs")) continue;
        const src = readFileSync(join(dir, file), "utf8");
        // A file that itself hosts the detector (imports the barrelSpy helper)
        // legitimately contains the literal sample in its self-check — skip it,
        // its occurrences are the guard's own demonstrations, not a spy under test.
        if (src.includes("helpers/barrelSpy")) continue;
        for (const name of barrelSpyViolations(src)) {
          violations.push(`${area}/${file}: vi.spyOn(${name}, …)`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
