// Contract tests for check:gate-enumeration.
//
// The property: the prose gate lists cannot disagree with package.json. They
// drifted on two consecutive nights (2026-07-29 added missing doc-links /
// nightly-routine-prompt rows and recorded that the ship skill "now matches
// package.json in exact order"; 2026-07-30 it was stale again because
// check:guard-reach had landed in between). Generation is the fix; these pin it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

import { STEP_GLOSS, ENUMERATION_TARGETS } from "../../scripts/gate-enumeration-data.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-gate-enumeration.mjs");

function verifyChecksSteps(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const script = pkg.scripts["verify:checks"];
  return script.slice(script.indexOf("verify-checks") + "verify-checks".length).trim().split(/\s+/).filter(Boolean);
}

function run(): { code: number; out: string } {
  try {
    const out = execFileSyncHidden("node", [CHECKER, REPO_ROOT], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check:gate-enumeration — the docs cannot drift from the real gate", () => {
  it("passes at HEAD", () => {
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  it("every verify:checks step has a gloss — an unglossed step is a build failure, not a silent bare name", () => {
    const missing = verifyChecksSteps().filter((s) => !STEP_GLOSS[s]);
    expect(missing, `add these to STEP_GLOSS: ${missing.join(", ")}`).toEqual([]);
  });

  it("both target docs actually contain the generated block and every step", () => {
    const steps = verifyChecksSteps();
    for (const target of ENUMERATION_TARGETS) {
      const body = readFileSync(join(REPO_ROOT, target.file), "utf8");
      expect(body, `${target.file} lost its markers`).toContain(`BEGIN ${target.marker}`);
      for (const step of steps) {
        expect(body, `${target.file} is missing gate step ${step}`).toContain(step);
      }
    }
  });

  it("renders steps in package.json's REAL order — order is read, never declared here", () => {
    const steps = verifyChecksSteps();
    for (const target of ENUMERATION_TARGETS) {
      const body = readFileSync(join(REPO_ROOT, target.file), "utf8");
      const positions = steps.map((s) => body.indexOf(`\`${s}\``));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions, `${target.file} renders the steps out of gate order`).toEqual(sorted);
    }
  });

  it("the gate is itself in the list it generates — so it can never be silently unwired", () => {
    expect(verifyChecksSteps()).toContain("check:gate-enumeration");
  });
});
