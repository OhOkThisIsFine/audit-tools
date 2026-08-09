// P16 (nightly sol-2, owner decision 2026-08-09): an informational flag never
// performs work, and every verb of a shipped bin answers --help.
//
// Both bins intercept the installer verbs before the dist CLI is reached, so
// commander — which answers `<verb> --help` natively for the commands it owns —
// never sees them. `remediate-code install --help` therefore RAN the installer
// and wrote four files; `audit-code install --help` did the same, because its
// leading-flag scan deliberately stops at the first non-flag token (it must, or
// `explain-task -v` would print the wrapper's version instead of forwarding it).
//
// These are the published commands and the affected verbs are the first ones a
// new operator touches; two of the four write into the repository and the home
// directory. "Ask the tool what this does" must not install anything.
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import { INSTALLER_VERBS } from "../../wrapper/installer-verb-help.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINS = [
  { name: "audit-code", entry: join(REPO_ROOT, "audit-code.mjs"), product: "/audit-code" },
  { name: "remediate-code", entry: join(REPO_ROOT, "remediate-code.mjs"), product: "/remediate-code" },
] as const;

let sandbox: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "verb-help-"));
  home = join(sandbox, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/**
 * Run a bin with cwd AND home redirected into the sandbox, so a verb that
 * writes repo-local assets and a verb that writes global ones are both caught
 * by the same "nothing was created" assertion.
 */
function runBin(entry: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  const out = spawnSyncHidden(process.execPath, [entry, ...args], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...cleanEnv, HOME: home, USERPROFILE: home },
  });
  return { code: out.status ?? -1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
}

describe("every installer verb of both shipped bins answers --help without doing work", () => {
  for (const bin of BINS) {
    for (const verb of INSTALLER_VERBS) {
      it(`${bin.name} ${verb} --help exits 0, names the verb, and writes nothing`, () => {
        const { code, stdout, stderr } = runBin(bin.entry, [verb, "--help"]);
        expect(code, `stderr: ${stderr}`).toBe(0);
        expect(stdout).toContain(verb);
        expect(stdout).toContain(bin.product);
        // The whole point: an informational flag performed no work. Nothing was
        // written to the working directory, and nothing to the home directory.
        expect(readdirSync(sandbox).filter((e) => e !== "home")).toEqual([]);
        expect(readdirSync(home)).toEqual([]);
      });
    }
  }

  it("-h is accepted as well as --help", () => {
    const { code, stdout, stderr } = runBin(BINS[0].entry, ["install", "-h"]);
    expect(code, `stderr: ${stderr}`).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("install");
    // Same no-work assertion as the --help cases: the installer's own JSON
    // output also contains the word "install", so stdout alone proves nothing.
    expect(readdirSync(sandbox).filter((e) => e !== "home")).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });
});

// The verb list lives in wrapper/installer-verb-help.mjs. Two other places
// enumerate the same verbs and cannot import it — remediate-code.mjs routes them
// with literal comparisons (a top-level wrapper/ import would break the tests
// that copy that bin alone into a temp dir), and src/remediate/index.ts is
// typechecked TypeScript with no allowJs, so it cannot import a .mjs module.
// These assertions are what keeps the three lists from drifting.
describe("the installer verb list has ONE source, pinned across the copies", () => {
  it("remediate-code.mjs routes exactly the verbs the shared module declares", () => {
    const text = readFileSync(join(REPO_ROOT, "remediate-code.mjs"), "utf8");
    const routed = [...text.matchAll(/verb === "([a-z-]+)"/g)].map((m) => m[1]);
    expect([...new Set(routed)].sort()).toEqual([...INSTALLER_VERBS].sort());
  });

  it("src/remediate/index.ts registers exactly those verbs for --help", () => {
    const text = readFileSync(join(REPO_ROOT, "src", "remediate", "index.ts"), "utf8");
    const block = /BIN_ROUTED_INSTALLER_VERBS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
    expect(block, "BIN_ROUTED_INSTALLER_VERBS not found").not.toBeNull();
    const registered = [...block![1].matchAll(/\[\s*"([a-z-]+)"/g)].map((m) => m[1]);
    expect(registered.sort()).toEqual([...INSTALLER_VERBS].sort());
  });

  it("the dist CLI no longer carries an ensure ACTION that the bin shadows", () => {
    const text = readFileSync(join(REPO_ROOT, "src", "remediate", "index.ts"), "utf8");
    // The shadowed registration was `.command("ensure")` followed by an action
    // calling ensureGlobalAssets — the bin calls installer.ensureBootstrap
    // instead, so that action could never run.
    expect(text).not.toMatch(/\.command\("ensure"\)[\s\S]{0,400}?ensureGlobalAssets/);
  });
});
