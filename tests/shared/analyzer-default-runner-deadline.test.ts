// INV-SSF residual (async-with-no-deadline): the acquisition engine and the
// binary resolver spawn through the ASYNC twin, which the INV-SSF token scan
// deliberately allows — but a `runTrackedAsync` call whose options carry no
// `timeout` arms NO deadline timer at all (exec.ts), so a child that never
// exits hangs the awaiting fold. A textual scan cannot see an ABSENT option,
// so the DEFAULT runners are pinned behaviorally here: every spawn they issue
// must declare a positive deadline. Injected runners are the caller's
// responsibility; the defaults are the tool's.
//
// UNCOVERED HALF, stated so the covered half does not read as a close: the
// closing-phase spawns (`src/remediate/phases/close.ts` — closing commands,
// combined suite, e2e) declare `CLOSING_CHILD_DEADLINE_MS` in code but are NOT
// pinned by any test; removing one of those timeouts reds nothing.
import { test, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExternalAnalyzerCandidate,
  EcosystemRunner,
} from "../../src/shared/analyzers/acquisitionEngine.js";
import type { BinarySpec } from "../../src/shared/analyzers/binaryAcquisition.js";

const spawnOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("../../src/shared/tooling/exec.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/shared/tooling/exec.js")>();
  return {
    ...actual,
    runTrackedAsync: async (
      argv: string[],
      options: Record<string, unknown> = {},
    ) => {
      spawnOptions.push(options);
      // Version probes want a version string; tool runs want parseable JSON.
      const stdout = argv.some((a) => a.includes("version")) ? "1.0.0" : "[]";
      return { status: 0, stdout, stderr: "", argv, duration_ms: 1 };
    },
  };
});

const { runExternalAnalyzer } = await import(
  "../../src/shared/analyzers/acquisitionEngine.js"
);
const { resolveBinary } = await import(
  "../../src/shared/analyzers/binaryAcquisition.js"
);

function expectEverySpawnBounded(): void {
  expect(
    spawnOptions.length,
    "the default runner must actually have spawned — an empty capture proves nothing",
  ).toBeGreaterThan(0);
  for (const options of spawnOptions) {
    expect(
      typeof options["timeout"],
      "every default-runner spawn must declare a deadline",
    ).toBe("number");
    expect(options["timeout"] as number).toBeGreaterThan(0);
  }
}

test("binary resolver's DEFAULT runner declares a deadline on every spawn", async () => {
  spawnOptions.length = 0;
  const spec: BinarySpec = {
    binaryName: "gitleaks",
    version: "9.9.9",
    versionProbeArgs: ["gitleaks", "version"],
    assetFor: () => "gitleaks_9.9.9_linux_x64.tar.gz",
    checksumsAsset: "gitleaks_9.9.9_checksums.txt",
    releaseUrlForAsset: (asset) => `https://example.test/${asset}`,
  };
  // The mocked probe exits 0, so resolution stops at the PATH leg — exactly one
  // default-runner spawn, and no cache/network side effects.
  const resolution = await resolveBinary(spec);
  expect(resolution.status).toBe("path");
  expectEverySpawnBounded();
});

test("acquisition engine's DEFAULT runner declares a deadline on every spawn", async () => {
  spawnOptions.length = 0;
  const candidate: ExternalAnalyzerCandidate = {
    id: "eslint",
    runner: "npx" as EcosystemRunner,
    spec: "eslint@9",
    safetyProfile: {
      config_execution: "executable",
      network_egress: false,
      version_pinning: "pinned",
    },
    // Curated-default so the consent chokepoint admits without a token.
    defaultRun: true,
    detect: () => true,
    buildArgv: (prefix: string[], root: string) => [
      ...prefix,
      "--format",
      "json",
      root,
    ],
    parse: (stdout: string) =>
      JSON.parse(stdout) as ReturnType<ExternalAnalyzerCandidate["parse"]>,
  };
  const root = await mkdtemp(join(tmpdir(), "aq-deadline-"));
  try {
    await runExternalAnalyzer(candidate, root, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expectEverySpawnBounded();
});
