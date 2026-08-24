import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type {
  BinarySpec,
  BinaryFetcher,
  BinaryCommandRunner,
} from "../../src/shared/analyzers/binaryAcquisition.js";
import type { ExternalAnalyzerCandidate } from "../../src/shared/analyzers/acquisitionEngine.js";
import type { RunTrackedResult } from "audit-tools/shared";

const { resolveBinary, expectedSha256For } = await import(
  "../../src/shared/analyzers/binaryAcquisition.js"
);
const { resolveBinaryCandidates, runExternalAnalyzer } = await import(
  "../../src/shared/analyzers/acquisitionEngine.js"
);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// A pinned binary spec whose asset is a fixed byte blob (the test "release").
function makeSpec(overrides: Partial<BinarySpec> = {}): BinarySpec {
  return {
    binaryName: "gitleaks",
    version: "9.9.9",
    versionProbeArgs: ["gitleaks", "version"],
    assetFor: (platform) =>
      platform === "win32"
        ? "gitleaks_9.9.9_windows_x64.zip"
        : "gitleaks_9.9.9_linux_x64.tar.gz",
    checksumsAsset: "gitleaks_9.9.9_checksums.txt",
    releaseUrlForAsset: (asset) => `https://example.test/${asset}`,
    ...overrides,
  };
}

const ASSET_BYTES = new TextEncoder().encode("FAKE-GITLEAKS-ARCHIVE");
const ASSET_NAME_POSIX = "gitleaks_9.9.9_linux_x64.tar.gz";

function checksumsText(assetName: string, digest: string): string {
  return `${digest}  ${assetName}\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other_asset.tar.gz\n`;
}

// A fetcher that serves the checksums file + the asset bytes.
function fetcher({ asset = ASSET_BYTES, digest }: { asset?: Uint8Array; digest?: string } = {}): BinaryFetcher {
  return async (url: string) => {
    if (url.endsWith("checksums.txt")) {
      return new TextEncoder().encode(
        checksumsText(ASSET_NAME_POSIX, digest ?? sha256(asset)),
      );
    }
    return asset;
  };
}

// A runner that fails the PATH probe and, for `tar`, "extracts" by writing the
// expected binary into the version dir (-C target).
function offlineRunnerExtractingTo(binaryName: string): BinaryCommandRunner {
  return async (argv: string[]): Promise<RunTrackedResult> => {
    if (argv[0] === "tar") {
      const dashC = argv.indexOf("-C");
      const dir = argv[dashC + 1];
      writeFileSync(join(dir, binaryName), "#!/bin/sh\n");
      return { status: 0, stdout: "", stderr: "", argv, duration_ms: 1 };
    }
    // PATH version-probe fails.
    return { status: 1, stdout: "", stderr: "not found", argv, duration_ms: 1, error: new Error("ENOENT") };
  };
}

function pathRunner(): BinaryCommandRunner {
  // PATH probe succeeds.
  return async (argv: string[]): Promise<RunTrackedResult> => ({
    status: 0,
    stdout: "gitleaks 8.x",
    stderr: "",
    argv,
    duration_ms: 1,
  });
}

// HERMETICITY: several cases below resolve with NO `cacheDir` argument, i.e. through
// the DEFAULT root — which is the real `~/.audit-tools/bincache`. Pinning
// AUDIT_TOOLS_BINARY_CACHE for the whole file keeps every one of them off the home
// directory of whoever runs the suite, and off any fixed shared path two concurrent
// runs could race over.
let suiteCacheRoot = "";
const priorSuiteOverride = process.env.AUDIT_TOOLS_BINARY_CACHE;

beforeAll(async () => {
  suiteCacheRoot = await mkdtemp(join(tmpdir(), "suite-bincache-"));
  process.env.AUDIT_TOOLS_BINARY_CACHE = suiteCacheRoot;
});

afterAll(async () => {
  if (priorSuiteOverride === undefined) delete process.env.AUDIT_TOOLS_BINARY_CACHE;
  else process.env.AUDIT_TOOLS_BINARY_CACHE = priorSuiteOverride;
  if (suiteCacheRoot) await rm(suiteCacheRoot, { recursive: true, force: true });
});

test("D-1: the DEFAULT cache root honours AUDIT_TOOLS_BINARY_CACHE", async () => {
  // Resolution with no `cacheDir` argument must land inside the override, not in the
  // home directory. This is what makes every default-root case in this file hermetic.
  // It takes its OWN root rather than the suite-wide one: this case DOWNLOADS, and a
  // warm cache left in the shared root would turn the later offline cases into hits.
  const ownRoot = await mkdtemp(join(tmpdir(), "d1-bincache-"));
  const prior = process.env.AUDIT_TOOLS_BINARY_CACHE;
  process.env.AUDIT_TOOLS_BINARY_CACHE = ownRoot;
  try {
    const res = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher(),
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("downloaded");
    expect(res.command, "the default root resolves to the overridden location").toContain(ownRoot);
    expect(
      res.command!.startsWith(join(homedir(), ".audit-tools")),
      "and never to the real per-user root",
    ).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.AUDIT_TOOLS_BINARY_CACHE;
    else process.env.AUDIT_TOOLS_BINARY_CACHE = prior;
    await rm(ownRoot, { recursive: true, force: true });
  }
});

test("expectedSha256For parses the matching asset line, ignores others", () => {
  const text = "abc123" + "0".repeat(58) + "  asset-a.tar.gz\n" + "f".repeat(64) + "  asset-b.zip";
  expect(expectedSha256For(text, "asset-b.zip")).toBe("f".repeat(64));
  expect(expectedSha256For(text, "missing")).toBe(null);
});

test("resolveBinary returns PATH when the tool is already installed", async () => {
  const res = await resolveBinary(makeSpec(), {
    run: pathRunner(),
    platform: "linux",
    arch: "x64",
  });
  expect(res.status).toBe("path");
  expect(res.command).toBe("gitleaks");
});

test("resolveBinary downloads + checksum-verifies + extracts when absent", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const res = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher(),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("downloaded");
    expect(res.command && existsSync(res.command), "extracted binary should exist").toBeTruthy();
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolveBinary refuses to extract/execute on a checksum mismatch", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const res = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      // Serve a digest that does NOT match the asset bytes.
      fetch: fetcher({ digest: "0".repeat(64) }),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("unavailable");
    expect(res.note ?? "").toMatch(/checksum mismatch/);
    expect(res.command).toBe(null);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolveBinary degrades to unavailable with no fetcher (offline) and no PATH", async () => {
  const res = await resolveBinary(makeSpec(), {
    run: offlineRunnerExtractingTo("gitleaks"),
    platform: "linux",
    arch: "x64",
  });
  expect(res.status).toBe("unavailable");
  expect(res.command).toBe(null);
});

test("resolveBinary(archived:false) writes the verified bytes directly as the executable, no tar", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const rawSpec = makeSpec({
      binaryName: "osv-scanner",
      assetFor: () => "osv-scanner_linux_amd64",
      checksumsAsset: "osv-scanner_SHA256SUMS",
      archived: false,
    });
    const rawBytes = new TextEncoder().encode("FAKE-RAW-EXECUTABLE-BYTES");
    const rawFetcher = async (url: string) => {
      if (url.endsWith("SHA256SUMS")) {
        return new TextEncoder().encode(
          `${sha256(rawBytes)}  osv-scanner_linux_amd64\n`,
        );
      }
      return rawBytes;
    };
    // A runner whose `tar` invocation would fail loudly — proves the
    // non-archived path never calls it.
    const runNeverCallsTar = () => {
      throw new Error("tar must never be invoked for a non-archived asset");
    };
    const res = await resolveBinary(rawSpec, {
      run: async (argv) => {
        if (argv[0] === "tar") return runNeverCallsTar();
        // PATH version-probe fails (forces the download path).
        return { status: 1, stdout: "", stderr: "not found", argv, duration_ms: 1, error: new Error("ENOENT") };
      },
      fetch: rawFetcher,
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("downloaded");
    expect(res.command && existsSync(res.command), "raw binary should be written to the cache").toBeTruthy();
    expect(readFileSync(res.command!, "utf8")).toBe("FAKE-RAW-EXECUTABLE-BYTES");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolveBinary(archived:false) still refuses a checksum mismatch", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const rawSpec = makeSpec({
      binaryName: "osv-scanner",
      assetFor: () => "osv-scanner_linux_amd64",
      checksumsAsset: "osv-scanner_SHA256SUMS",
      archived: false,
    });
    const res = await resolveBinary(rawSpec, {
      run: async (argv) => ({
        status: 1,
        stdout: "",
        stderr: "",
        argv,
        duration_ms: 1,
        error: new Error("ENOENT"),
      }),
      fetch: async (url) =>
        url.endsWith("SHA256SUMS")
          ? new TextEncoder().encode(`${"0".repeat(64)}  osv-scanner_linux_amd64\n`)
          : new TextEncoder().encode("bytes"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("unavailable");
    expect(res.note ?? "").toMatch(/checksum mismatch/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("resolveBinary returns unavailable when the os/arch has no asset", async () => {
  const res = await resolveBinary(makeSpec({ assetFor: () => null }), {
    run: offlineRunnerExtractingTo("gitleaks"),
    fetch: fetcher(),
    platform: "sunos",
    arch: "mips",
  });
  expect(res.status).toBe("unavailable");
  expect(res.note ?? "").toMatch(/no release asset/);
});

const binaryCandidate = (overrides: Partial<ExternalAnalyzerCandidate> = {}): ExternalAnalyzerCandidate => ({
  id: "gitleaks",
  runner: "binary",
  spec: "9.9.9",
  safetyProfile: {
    config_execution: "none",
    network_egress: false,
    version_pinning: "pinned",
  },
  defaultRun: true,
  detect: () => true,
  buildArgv: (prefix: string[], root: string) => [...prefix, "detect", "--source", root],
  parse: () => [],
  binary: makeSpec(),
  ...overrides,
});

test("resolveBinaryCandidates resolves a present tool and records gaps for absent ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "binc-"));
  try {
    const present = await resolveBinaryCandidates([binaryCandidate()], dir, {
      run: pathRunner(),
    });
    expect(present.resolvedBinaries.gitleaks).toBe("gitleaks");
    expect(present.unresolvedStatuses.length).toBe(0);

    // Offline + no fetcher ⇒ not_resolved status, no silent drop.
    const absent = await resolveBinaryCandidates([binaryCandidate()], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
    });
    expect(Object.keys(absent.resolvedBinaries).length).toBe(0);
    expect(absent.unresolvedStatuses[0].status).toBe("not_resolved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveBinaryCandidates skips a non-default binary without a consent token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "binc-"));
  try {
    const out = await resolveBinaryCandidates(
      [binaryCandidate({ defaultRun: false })],
      dir,
      { run: pathRunner() },
    );
    expect(Object.keys(out.resolvedBinaries).length).toBe(0);
    expect(out.unresolvedStatuses[0].status).toBe("skipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runExternalAnalyzer runs a binary candidate via its resolved path", async () => {
  const captured: string[][] = [];
  const out = await runExternalAnalyzer(binaryCandidate(), "/repo", {
    resolvedBinaries: { gitleaks: "/cache/gitleaks" },
    run: async (argv) => {
      captured.push(argv);
      return { status: 0, stdout: "[]", stderr: "", argv, duration_ms: 1 };
    },
  });
  expect(out.status.status).toBe("success");
  expect(captured[0]).toEqual(["/cache/gitleaks", "detect", "--source", "/repo"]);
});

test("runExternalAnalyzer reports not_resolved when a binary was not acquired", async () => {
  const out = await runExternalAnalyzer(binaryCandidate(), "/repo", {
    resolvedBinaries: {},
    run: async () => ({ status: 0, stdout: "", stderr: "", argv: [], duration_ms: 1 }),
  });
  expect(out.status.status).toBe("not_resolved");
  expect(out.results.results.length).toBe(0);
});

// ───────────────────────────────────────────────────────────────────────────
// inv-5 / inv-6 / fail-4: the CACHE branch is held to the same bar as the download
// branch. The cache root is predictable and world-writable by default, so "a file
// exists at the expected name" is a claim, not a proof.
// ───────────────────────────────────────────────────────────────────────────

test("inv-5: a re-resolution of a legitimately downloaded binary IS a verified cache hit", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const options = {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher(),
      cacheDir,
      platform: "linux" as NodeJS.Platform,
      arch: "x64",
    };
    const first = await resolveBinary(makeSpec(), options);
    expect(first.status).toBe("downloaded");
    // Second resolution: same bytes, so the recorded digest still matches.
    const second = await resolveBinary(makeSpec(), options);
    expect(second.status, "an untampered cached binary still resolves as cached").toBe("cached");
    expect(second.command).toBe(first.command);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("inv-5 / fail-4: bytes PRE-PLANTED at the predictable cache path are never executed as `cached`", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    // The attack the finding reproduces: the path is fully derivable from the public
    // pinned spec, so anyone able to write the temp dir can put a binary there first.
    const versionDir = join(cacheDir, "gitleaks-9.9.9");
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(join(versionDir, "gitleaks"), "#!/bin/sh\nmalicious\n");

    const res = await resolveBinary(makeSpec(), {
      // No fetcher: if the planted file were trusted this would return `cached`.
      run: offlineRunnerExtractingTo("gitleaks"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(res.status, "unverifiable cached bytes must never resolve").toBe("unavailable");
    expect(res.command).toBe(null);
    expect(res.reason).toBe("offline");
    expect(
      existsSync(join(versionDir, "gitleaks")),
      "the unverifiable cache entry is purged, not left to be picked up next time",
    ).toBe(false);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});


test("inv-6: a FAILED extraction leaves nothing a later resolution can take as a cache hit", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    // tar writes the executable and THEN fails — the partial-extract case.
    const partialExtractThenFail: BinaryCommandRunner = async (
      argv: string[],
    ): Promise<RunTrackedResult> => {
      if (argv[0] === "tar") {
        const dir = argv[argv.indexOf("-C") + 1];
        writeFileSync(join(dir, "gitleaks"), "#!/bin/sh\nhalf-extracted\n");
        return { status: 1, stdout: "", stderr: "tar: truncated", argv, duration_ms: 1 };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "not found",
        argv,
        duration_ms: 1,
        error: new Error("ENOENT"),
      };
    };

    const failed = await resolveBinary(makeSpec(), {
      run: partialExtractThenFail,
      fetch: fetcher(),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(failed.status).toBe("unavailable");
    expect(failed.reason).toBe("extract_failed");
    expect(
      existsSync(join(cacheDir, "gitleaks-9.9.9", "gitleaks")),
      "whatever tar wrote before failing must not survive the failure",
    ).toBe(false);

    // The second resolution must NOT report `cached` off the half-written bytes.
    const second = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(second.status, "a partial extract can never become a later cache hit").not.toBe("cached");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// inv-9: a checksum mismatch is a supply-chain event with its OWN machine-readable
// member — never flattened into the same record as "this machine is offline".
// ───────────────────────────────────────────────────────────────────────────

test("inv-9: resolveBinary carries a discriminated reason; offline and checksum mismatch are not the same", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-"));
  try {
    const mismatch = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher({ digest: "0".repeat(64) }),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    const offline = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(mismatch.reason).toBe("checksum_mismatch");
    expect(offline.reason).toBe("offline");
    expect(
      mismatch.reason === offline.reason,
      "the two must be machine-distinguishable, not only distinguishable in prose",
    ).toBe(false);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("inv-9: a checksum mismatch surfaces as its OWN ExternalAnalyzerToolStatus member", async () => {
  const dir = await mkdtemp(join(tmpdir(), "binc-"));
  try {
    const tampered = await resolveBinaryCandidates([binaryCandidate()], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher({ digest: "0".repeat(64) }),
      cacheDir: join(dir, "cache"),
      platform: "linux",
      arch: "x64",
    });
    expect(tampered.unresolvedStatuses[0].status).toBe("checksum_mismatch");
    expect(tampered.unresolvedStatuses[0].error).toMatch(/checksum mismatch/);

    // The offline run stays `not_resolved` — the two records are not interchangeable.
    const offline = await resolveBinaryCandidates([binaryCandidate()], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
      cacheDir: join(dir, "cache-2"),
      platform: "linux",
      arch: "x64",
    });
    expect(offline.unresolvedStatuses[0].status).toBe("not_resolved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// inv-4: a denial performs ZERO network I/O, not merely a `skipped` record.
// ───────────────────────────────────────────────────────────────────────────

test("inv-4: a consent-denied binary candidate fetches NOTHING (no download, not just no spawn)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "binc-"));
  try {
    let fetches = 0;
    const countingFetch: BinaryFetcher = async (url: string) => {
      fetches += 1;
      return fetcher()(url);
    };
    // Denied two ways: an undecided non-default tool, and a recorded decline.
    const undecided = await resolveBinaryCandidates([binaryCandidate({ defaultRun: false })], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: countingFetch,
      cacheDir: join(dir, "cache"),
      platform: "linux",
      arch: "x64",
    });
    expect(undecided.unresolvedStatuses[0].status).toBe("skipped");

    const declined = await resolveBinaryCandidates([binaryCandidate({ defaultRun: true })], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: countingFetch,
      analyzerConsent: { gitleaks: "declined" },
      cacheDir: join(dir, "cache"),
      platform: "linux",
      arch: "x64",
    });
    expect(
      declined.unresolvedStatuses[0].status,
      "a recorded decline stops even a DEFAULT-set binary",
    ).toBe("skipped");
    expect(declined.unresolvedStatuses[0].error).toMatch(/declined/);

    expect(fetches, "a denial must perform zero network I/O").toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// inv-14: win32 — the repo's primary dev platform, previously uncovered. `.exe`
// naming, the zip/archive branch, and the POSIX-only chmod skip.
// ───────────────────────────────────────────────────────────────────────────

/** A win32 runner: the PATH probe fails and the archive tool writes `<name>.exe`. */
function win32ExtractingRunner(binaryName: string): BinaryCommandRunner {
  return async (argv: string[]): Promise<RunTrackedResult> => {
    if (argv[0] === "tar") {
      const dir = argv[argv.indexOf("-C") + 1];
      writeFileSync(join(dir, `${binaryName}.exe`), "MZ-fake-windows-binary");
      return { status: 0, stdout: "", stderr: "", argv, duration_ms: 1 };
    }
    return {
      status: 1,
      stdout: "",
      stderr: "not recognized",
      argv,
      duration_ms: 1,
      error: new Error("ENOENT"),
    };
  };
}

test("inv-14: win32 ARCHIVED asset resolves the .exe out of the zip, and re-verifies as cached", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-win-"));
  try {
    const winAsset = "gitleaks_9.9.9_windows_x64.zip";
    const winFetch: BinaryFetcher = async (url: string) =>
      url.endsWith("checksums.txt")
        ? new TextEncoder().encode(checksumsText(winAsset, sha256(ASSET_BYTES)))
        : ASSET_BYTES;
    const res = await resolveBinary(makeSpec(), {
      run: win32ExtractingRunner("gitleaks"),
      fetch: winFetch,
      cacheDir,
      platform: "win32",
      arch: "x64",
    });
    expect(res.status).toBe("downloaded");
    expect(res.command, "win32 resolves the .exe-suffixed name").toMatch(/gitleaks\.exe$/);
    expect(existsSync(res.command!)).toBe(true);
    // The POSIX-only chmod is skipped on win32; the resolution completing with the
    // executable in place is what that branch has to produce.
    expect(readFileSync(res.command!, "utf8")).toBe("MZ-fake-windows-binary");

    // …and the win32 cache entry re-verifies on the next resolution (no fetcher, so
    // a cache miss here would be `unavailable`, not a silent re-download).
    const again = await resolveBinary(makeSpec(), {
      run: win32ExtractingRunner("gitleaks"),
      cacheDir,
      platform: "win32",
      arch: "x64",
    });
    expect(again.status).toBe("cached");
    expect(again.command).toMatch(/gitleaks\.exe$/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("inv-14: win32 archived:false writes the verified bytes straight to <name>.exe, no tar", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-win-raw-"));
  try {
    const rawBytes = new TextEncoder().encode("MZ-fake-osv-scanner");
    const asset = "osv-scanner_windows_amd64.exe";
    const rawSpec = makeSpec({
      binaryName: "osv-scanner",
      assetFor: () => asset,
      checksumsAsset: "osv-scanner_SHA256SUMS",
      archived: false,
    });
    const res = await resolveBinary(rawSpec, {
      run: async (argv: string[]): Promise<RunTrackedResult> => {
        if (argv[0] === "tar") throw new Error("tar must never run for a non-archived asset");
        return {
          status: 1,
          stdout: "",
          stderr: "",
          argv,
          duration_ms: 1,
          error: new Error("ENOENT"),
        };
      },
      fetch: async (url: string) =>
        url.endsWith("SHA256SUMS")
          ? new TextEncoder().encode(`${sha256(rawBytes)}  ${asset}
`)
          : rawBytes,
      cacheDir,
      platform: "win32",
      arch: "x64",
    });
    expect(res.status).toBe("downloaded");
    expect(res.command).toMatch(/osv-scanner\.exe$/);
    expect(readFileSync(res.command!, "utf8")).toBe("MZ-fake-osv-scanner");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// RV-2: the digest manifest is INTEGRITY, not provenance.
//
// An attacker who can write the cache dir writes the binary AND a matching manifest,
// so a self-consistent pair inside a world-writable location proves nothing. The
// manifest only means something when the directory is not attacker-writable, which is
// what the per-user default root buys. The strongest mechanically-testable property
// is therefore about LOCATION: the default root is per-user, and a plant at the old
// shared-tmpdir path is never consulted at all.
//
// HERMETICITY: the default root is exercised through AUDIT_TOOLS_BINARY_CACHE pointed
// at a mkdtemp dir, so this never writes to the real HOME. The legacy plant likewise
// goes in a mkdtemp dir shaped like the old shared root rather than at the fixed
// `<tmpdir>/audit-tools-bincache` — two concurrent `npm test` runs would race over
// that one path, and a real machine's legacy cache must not be deleted by a test.
// ───────────────────────────────────────────────────────────────────────────

test("RV-2: the DEFAULT cache root is per-user — a self-consistent plant elsewhere is never consulted", async () => {
  // A complete attacker payload: executable + a manifest whose digest matches it. The
  // integrity layer alone cannot refuse this, which is the whole point — only the
  // location layer can, by never looking there.
  const legacyRoot = await mkdtemp(join(tmpdir(), "legacy-bincache-"));
  const defaultRoot = await mkdtemp(join(tmpdir(), "default-bincache-"));
  const legacyVersionDir = join(legacyRoot, "gitleaks-9.9.9");
  const plantedBytes = "#!/bin/sh\nplanted-by-another-local-process\n";
  mkdirSync(legacyVersionDir, { recursive: true });
  const plantedExe = join(legacyVersionDir, "gitleaks");
  writeFileSync(plantedExe, plantedBytes);
  writeFileSync(
    join(legacyVersionDir, ".audit-tools-binary.json"),
    JSON.stringify({
      binaryName: "gitleaks",
      version: "9.9.9",
      executable_relative_path: "gitleaks",
      executable_sha256: sha256(new TextEncoder().encode(plantedBytes)),
    }),
  );
  // The real per-user root must be left exactly as it was found — this test exercises
  // the DEFAULT path, so without the override it would create or write to the actual
  // home directory of whoever runs the suite.
  const realUserRoot = join(homedir(), ".audit-tools", "bincache");
  const realUserRootExistedBefore = existsSync(realUserRoot);
  const priorOverride = process.env.AUDIT_TOOLS_BINARY_CACHE;
  process.env.AUDIT_TOOLS_BINARY_CACHE = defaultRoot;
  try {
    const res = await resolveBinary(makeSpec(), {
      // No `cacheDir` argument: resolution takes the DEFAULT root, which the override
      // pins to a private dir. Were the default still the shared location the plant
      // sits in, this self-consistent pair would resolve as `cached` and be spawned.
      run: offlineRunnerExtractingTo("gitleaks"),
      platform: "linux",
      arch: "x64",
    });
    expect(res.status, "a plant outside the default root must never be consulted").toBe(
      "unavailable",
    );
    expect(res.command).toBe(null);
    expect(
      existsSync(plantedExe),
      "and it is not purged either — it is simply outside the cache root now",
    ).toBe(true);
    expect(
      existsSync(realUserRoot),
      "the override must keep this test off the real home directory entirely",
    ).toBe(realUserRootExistedBefore);
  } finally {
    if (priorOverride === undefined) delete process.env.AUDIT_TOOLS_BINARY_CACHE;
    else process.env.AUDIT_TOOLS_BINARY_CACHE = priorOverride;
    await rm(legacyRoot, { recursive: true, force: true });
    await rm(defaultRoot, { recursive: true, force: true });
  }
});

test("RV-2 / D-4: a resolution that caches NOTHING creates no cache directory", async () => {
  // The root is created only where bytes are about to be written. A machine that
  // already has the tool, or that is offline, must not grow an empty cache dir per
  // run — read paths only ask whether the directory exists.
  const parent = await mkdtemp(join(tmpdir(), "nocache-"));
  const priorOverride = process.env.AUDIT_TOOLS_BINARY_CACHE;
  try {
    const onPath = join(parent, "path-branch");
    process.env.AUDIT_TOOLS_BINARY_CACHE = onPath;
    const res = await resolveBinary(makeSpec(), {
      run: pathRunner(),
      platform: "linux",
      arch: "x64",
    });
    expect(res.status).toBe("path");
    expect(existsSync(onPath), "the PATH branch consults no cache, so it creates none").toBe(false);

    // Offline: a cache MISS is a read, and a read creates nothing either.
    const offline = join(parent, "offline-branch");
    process.env.AUDIT_TOOLS_BINARY_CACHE = offline;
    const degraded = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      platform: "linux",
      arch: "x64",
    });
    expect(degraded.status).toBe("unavailable");
    expect(degraded.reason).toBe("offline");
    expect(existsSync(offline), "a cache miss with nothing to write creates no directory").toBe(
      false,
    );
  } finally {
    if (priorOverride === undefined) delete process.env.AUDIT_TOOLS_BINARY_CACHE;
    else process.env.AUDIT_TOOLS_BINARY_CACHE = priorOverride;
    await rm(parent, { recursive: true, force: true });
  }
});

test("RV-2: the integrity layer still catches drift inside a trusted cache root", async () => {
  // Within a directory the caller owns, the manifest is what detects tampered or
  // partially-written bytes. This is the layer's real job; it is NOT provenance, and
  // the location layer above is what makes writing a matching pair privileged.
  const cacheDir = await mkdtemp(join(tmpdir(), "bincache-trusted-"));
  try {
    const downloaded = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      fetch: fetcher(),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(downloaded.status).toBe("downloaded");
    writeFileSync(downloaded.command!, "#!/bin/sh\ndrifted\n");

    const after = await resolveBinary(makeSpec(), {
      run: offlineRunnerExtractingTo("gitleaks"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    expect(after.status, "bytes that no longer match the recorded digest are refused").toBe(
      "unavailable",
    );
    expect(existsSync(downloaded.command!), "and the drifted entry is purged").toBe(false);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
