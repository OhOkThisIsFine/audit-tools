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

/** The one candidate both deadline tests drive — curated-default, so admitted token-free. */
function defaultAdmittedCandidate(): ExternalAnalyzerCandidate {
  return {
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
}

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
  const candidate = defaultAdmittedCandidate();
  const root = await mkdtemp(join(tmpdir(), "aq-deadline-"));
  try {
    await runExternalAnalyzer(candidate, root, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expectEverySpawnBounded();
});

// ── P61: the deadline is PROPAGATED, not re-typed ────────────────────────────
// The test above pins only that a bound EXISTS. A bound that exists but is
// ten minutes long satisfies it while still handing a child a longer wait than
// the caller awaiting it will wait — which is the measured defect. These pin
// the two halves of the propagation contract: the caller's remaining budget
// reaches the child, and the layer's own cap can shorten it but never lengthen
// it.
test("a caller-supplied deadline reaches the spawned child as its timeout", async () => {
  spawnOptions.length = 0;
  const candidate = defaultAdmittedCandidate();
  const root = await mkdtemp(join(tmpdir(), "aq-prop-"));
  try {
    await runExternalAnalyzer(candidate, root, { deadline: { at: Date.now() + 4_000 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(spawnOptions.length).toBeGreaterThan(0);
  for (const options of spawnOptions) {
    const timeout = options["timeout"] as number;
    // The cap is two minutes; a 4-second caller must not be handed it.
    expect(
      timeout,
      "the caller's remaining budget must bound the child, not this layer's cap",
    ).toBeLessThanOrEqual(4_000);
    expect(timeout).toBeGreaterThan(0);
  }
});

test("the acquisition cap never exceeds the fold child deadline", async () => {
  const { ANALYZER_CHILD_DEADLINE_MS } = await import(
    "../../src/shared/analyzers/acquisitionEngine.js"
  );
  const { TRACKED_CHILD_DEADLINE_MS } = await import("../../src/shared/tooling/exec.js");
  // Ten minutes under a five-minute caller is the defect this constant used to
  // BE. A cap is only meaningful relative to the caller that must outlive it.
  expect(ANALYZER_CHILD_DEADLINE_MS).toBeLessThanOrEqual(TRACKED_CHILD_DEADLINE_MS);
});
