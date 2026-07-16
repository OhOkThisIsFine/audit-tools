/**
 * `loadRemediateSessionConfig` — remediate's single config-load seam.
 *
 * REGRESSION GUARD for the un-released capability loss vs v0.32.68: remediate resolved
 * its session config with a `null` auditor descriptor at all three dispatch sites, which
 * FAILS CLOSED to driver-self-only, so remediate could not dispatch to ANY non-self pool.
 * v0.32.68 read `sources[]` straight off disk and could. The fix routes every site through
 * this loader, which always resolves against the AMBIENT descriptor — making the `null`
 * choice unrepresentable rather than something each call site must remember.
 *
 * Contract enforced:
 *   1. AMBIENT POOL: a declared + ambient-verifiable source reaches `effective.sources`
 *      (this is the assertion that goes RED if the loader reverts to a null descriptor).
 *   2. REACH FILTER: a declared-but-unreachable source is dropped (`declared ∩ ambient`).
 *   3. OVERRIDE WINS: a programmatic effective config bypasses the disk read entirely.
 *   4. READ-PATH POLICY preserved verbatim: `artifactsFirst` tries the artifacts dir
 *      first; without it only `<root>/session-config.json` is read.
 *   5. INTENT PRESERVED: policy fields survive resolution untouched.
 *
 * Red-green validated: reverting the loader's descriptor to `null` fails case 1.
 */

import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadRemediateSessionConfig } = await import(
  "../../src/remediate/steps/sessionConfigLoad.ts"
);

/** One reachable lane (its key env var is set) + one unreachable (its var is not). */
const ambient = () => ({
  env: { NIM_KEY: "sk-real" },
  homeDir: "/home/t",
  commandExists: () => false,
  fileReadable: () => false,
  readDeclarationFile: () =>
    JSON.stringify({
      sources: [
        {
          provider: "openai-compatible",
          endpoint: "https://nim.example/v1",
          model: "reachable-model",
          api_key_env: "NIM_KEY",
        },
        {
          provider: "openai-compatible",
          endpoint: "https://nim.example/v1",
          model: "unreachable-model",
          api_key_env: "ABSENT_KEY",
        },
      ],
    }),
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "remediate-cfg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadRemediateSessionConfig", () => {
  test("resolves an ambient dispatch pool — remediate is NOT driver-self-only", async () => {
    await writeFile(
      join(root, "session-config.json"),
      JSON.stringify({ synthesis: { narrative: true } }),
    );
    const eff = await loadRemediateSessionConfig({
      root,
      artifactsFirst: false,
      ambient: ambient(),
    });
    // The regression assertion: a null descriptor would leave this undefined.
    expect(eff?.sources).toBeDefined();
    expect(eff?.sources?.map((s) => s.model)).toEqual(["reachable-model"]);
  });

  test("drops a declared-but-unreachable source (declared ∩ ambient-verifiable)", async () => {
    await writeFile(join(root, "session-config.json"), JSON.stringify({}));
    const eff = await loadRemediateSessionConfig({
      root,
      artifactsFirst: false,
      ambient: ambient(),
    });
    // Assert the pool resolved FIRST — otherwise `not.toContain` on an undefined pool
    // would "pass" for the wrong reason (a vacuous guard is worse than none).
    expect(eff?.sources).toBeDefined();
    expect(eff?.sources?.map((s) => s.model)).not.toContain("unreachable-model");
  });

  test("a programmatic effective override bypasses the disk read", async () => {
    await writeFile(
      join(root, "session-config.json"),
      JSON.stringify({ synthesis: { narrative: true } }),
    );
    const override = { provider: "codex" as const, dispatch: { max_packets: 3 } };
    const eff = await loadRemediateSessionConfig({
      root,
      override,
      artifactsFirst: false,
      ambient: ambient(),
    });
    expect(eff).toBe(override);
    expect(eff?.sources).toBeUndefined();
  });

  test("artifactsFirst reads the artifacts dir before the root config", async () => {
    await mkdir(join(root, ".remediation-artifacts"), { recursive: true });
    await writeFile(
      join(root, ".remediation-artifacts", "session-config.json"),
      JSON.stringify({ dispatch: { max_packets: 11 } }),
    );
    await writeFile(
      join(root, "session-config.json"),
      JSON.stringify({ dispatch: { max_packets: 22 } }),
    );
    const first = await loadRemediateSessionConfig({
      root,
      artifactsFirst: true,
      ambient: ambient(),
    });
    expect(first?.dispatch?.max_packets).toBe(11);
    // Without it, the artifacts dir is not consulted — the read-path policy the
    // contract-pipeline scheduling path relies on, preserved verbatim by the extraction.
    const rootOnly = await loadRemediateSessionConfig({
      root,
      artifactsFirst: false,
      ambient: ambient(),
    });
    expect(rootOnly?.dispatch?.max_packets).toBe(22);
  });

  test("absent config → undefined (no invented floor)", async () => {
    const eff = await loadRemediateSessionConfig({
      root,
      artifactsFirst: true,
      ambient: ambient(),
    });
    expect(eff).toBeUndefined();
  });

  test("intent policy fields survive resolution untouched", async () => {
    const intent = {
      synthesis: { narrative: true },
      analyzers: { gitleaks: "ephemeral" },
      dispatch: { max_packets: 7 },
    };
    await writeFile(join(root, "session-config.json"), JSON.stringify(intent));
    const eff = await loadRemediateSessionConfig({
      root,
      artifactsFirst: false,
      ambient: ambient(),
    });
    expect(eff?.synthesis).toEqual(intent.synthesis);
    expect(eff?.analyzers).toEqual(intent.analyzers);
    expect(eff?.dispatch).toEqual(intent.dispatch);
  });
});
