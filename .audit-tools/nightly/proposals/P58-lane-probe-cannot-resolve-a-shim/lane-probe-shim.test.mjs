// P58 red-green test — the offload-lane command probe must resolve a Windows
// npm shim.
//
// Machine-wide target: ~/.agent-config/offload-lane-data.mjs (`probeLane` →
// `probeCommand`). It spawns `probe.command` as a bare argv[0] with no shell and
// no shim resolution, so on Windows a lane whose command exists only as
// `<name>.cmd` on PATH raises ENOENT. `probeCommand` maps the child's `error`
// event to `done(false)` — reported as DOWN, indistinguishable from a lane that
// is genuinely dead.
//
// The test is hermetic: it builds its own shim on a temp PATH and never touches
// a real lane or spends quota.
//
// Run: node --test lane-probe-shim.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// P58_REGISTRY points the test at a candidate copy, so the green half can be
// proven without landing the patch (leg 3 lands nothing).
const REGISTRY =
  process.env.P58_REGISTRY || join(homedir(), ".agent-config", "offload-lane-data.mjs");

test("a command probe resolves a bare name backed only by a .cmd shim", async () => {
  const { probeLane } = await import(pathToFileURL(REGISTRY).href);

  const dir = mkdtempSync(join(tmpdir(), "p58-shim-"));
  // The npm shim pair: a POSIX script and the Windows .cmd wrapper. A bare
  // `spawn` on win32 resolves neither without shim handling.
  writeFileSync(join(dir, "p58probe.cmd"), "@echo off\r\nexit /b 0\r\n");
  writeFileSync(join(dir, "p58probe"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "p58probe"), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${previousPath}`;
  try {
    const lane = {
      id: "p58-fixture",
      kind: "peer-cli",
      label: "P58 fixture lane",
      transport: "none",
      probe: { kind: "command", command: "p58probe", args: [], timeoutMs: 10_000 },
      remedy: "n/a",
    };
    const up = await probeLane(lane, process.env);
    assert.equal(
      up,
      true,
      "a launchable CLI backed by a .cmd shim must probe UP; `false` here is a " +
        "false DOWN that reads as a dead lane",
    );
  } finally {
    process.env.PATH = previousPath;
  }
});
