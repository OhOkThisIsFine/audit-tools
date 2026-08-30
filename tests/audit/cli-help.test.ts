import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

import { captureConsole } from "./helpers/captureConsole.mjs";

const { COMMAND_ROUTES, runCli } = await import("../../src/audit/cli.js");

test.each(["--help", "-h"])(
  "subcommand %s is informational and side-effect free",
  async (helpFlag) => {
    const root = await mkdtemp(join(tmpdir(), "audit-code-cli-help-"));

    try {
      const result = await captureConsole(() =>
        runCli(["node", "cli.js", "next-step", helpFlag, "--root", root]),
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: audit-code next-step [options]");
      for (const [verb] of COMMAND_ROUTES) {
        expect(result.stdout).toContain(verb);
      }
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
