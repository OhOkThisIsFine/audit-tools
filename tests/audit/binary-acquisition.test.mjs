import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const { resolveBinary, expectedSha256For } = await import(
  "../../src/audit/extractors/analyzers/binaryAcquisition.ts"
);
const { resolveBinaryCandidates, runExternalAnalyzer } = await import(
  "../../src/audit/extractors/analyzers/acquisitionEngine.ts"
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A pinned binary spec whose asset is a fixed byte blob (the test "release").
function makeSpec(overrides = {}) {
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

function checksumsText(assetName, digest) {
  return `${digest}  ${assetName}\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other_asset.tar.gz\n`;
}

// A fetcher that serves the checksums file + the asset bytes.
function fetcher({ asset = ASSET_BYTES, digest } = {}) {
  return async (url) => {
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
function offlineRunnerExtractingTo(binaryName) {
  return (argv) => {
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

function pathRunner() {
  // PATH probe succeeds.
  return (argv) => ({ status: 0, stdout: "gitleaks 8.x", stderr: "", argv, duration_ms: 1 });
}

test("expectedSha256For parses the matching asset line, ignores others", () => {
  const text = "abc123" + "0".repeat(58) + "  asset-a.tar.gz\n" + "f".repeat(64) + "  asset-b.zip";
  assert.equal(expectedSha256For(text, "asset-b.zip"), "f".repeat(64));
  assert.equal(expectedSha256For(text, "missing"), null);
});

test("resolveBinary returns PATH when the tool is already installed", async () => {
  const res = await resolveBinary(makeSpec(), {
    run: pathRunner(),
    platform: "linux",
    arch: "x64",
  });
  assert.equal(res.status, "path");
  assert.equal(res.command, "gitleaks");
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
    assert.equal(res.status, "downloaded");
    assert.ok(res.command && existsSync(res.command), "extracted binary should exist");
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
    assert.equal(res.status, "unavailable");
    assert.match(res.note ?? "", /checksum mismatch/);
    assert.equal(res.command, null);
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
  assert.equal(res.status, "unavailable");
  assert.equal(res.command, null);
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
    const rawFetcher = async (url) => {
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
      run: (argv) => {
        if (argv[0] === "tar") return runNeverCallsTar();
        // PATH version-probe fails (forces the download path).
        return { status: 1, stdout: "", stderr: "not found", argv, duration_ms: 1, error: new Error("ENOENT") };
      },
      fetch: rawFetcher,
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    assert.equal(res.status, "downloaded");
    assert.ok(res.command && existsSync(res.command), "raw binary should be written to the cache");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(res.command, "utf8"), "FAKE-RAW-EXECUTABLE-BYTES");
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
      run: (argv) => ({ status: 1, stdout: "", stderr: "", argv, duration_ms: 1, error: new Error("ENOENT") }),
      fetch: async (url) =>
        url.endsWith("SHA256SUMS")
          ? new TextEncoder().encode(`${"0".repeat(64)}  osv-scanner_linux_amd64\n`)
          : new TextEncoder().encode("bytes"),
      cacheDir,
      platform: "linux",
      arch: "x64",
    });
    assert.equal(res.status, "unavailable");
    assert.match(res.note ?? "", /checksum mismatch/);
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
  assert.equal(res.status, "unavailable");
  assert.match(res.note ?? "", /no release asset/);
});

const binaryCandidate = (overrides = {}) => ({
  id: "gitleaks",
  runner: "binary",
  spec: "9.9.9",
  defaultRun: true,
  detect: () => true,
  buildArgv: (prefix, root) => [...prefix, "detect", "--source", root],
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
    assert.equal(present.resolvedBinaries.gitleaks, "gitleaks");
    assert.equal(present.unresolvedStatuses.length, 0);

    // Offline + no fetcher ⇒ not_resolved status, no silent drop.
    const absent = await resolveBinaryCandidates([binaryCandidate()], dir, {
      run: offlineRunnerExtractingTo("gitleaks"),
    });
    assert.equal(Object.keys(absent.resolvedBinaries).length, 0);
    assert.equal(absent.unresolvedStatuses[0].status, "not_resolved");
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
    assert.equal(Object.keys(out.resolvedBinaries).length, 0);
    assert.equal(out.unresolvedStatuses[0].status, "skipped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runExternalAnalyzer runs a binary candidate via its resolved path", () => {
  const captured = [];
  const out = runExternalAnalyzer(binaryCandidate(), "/repo", {
    resolvedBinaries: { gitleaks: "/cache/gitleaks" },
    run: (argv) => {
      captured.push(argv);
      return { status: 0, stdout: "[]", stderr: "", argv, duration_ms: 1 };
    },
  });
  assert.equal(out.status.status, "success");
  assert.deepEqual(captured[0], ["/cache/gitleaks", "detect", "--source", "/repo"]);
});

test("runExternalAnalyzer reports not_resolved when a binary was not acquired", () => {
  const out = runExternalAnalyzer(binaryCandidate(), "/repo", {
    resolvedBinaries: {},
    run: () => ({ status: 0, stdout: "", stderr: "", argv: [], duration_ms: 1 }),
  });
  assert.equal(out.status.status, "not_resolved");
  assert.equal(out.results.results.length, 0);
});
