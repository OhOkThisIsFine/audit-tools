import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_ROOT = scratchDir(".test-postinstall-source-bootstrap");

describe("source-checkout postinstall bootstrap", () => {
  afterEach(async () => {
    await rm(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it("builds shared output before either host deployer runs", async () => {
    await mkdir(join(FIXTURE_ROOT, "scripts", "audit"), { recursive: true });
    await mkdir(join(FIXTURE_ROOT, "scripts", "remediate"), { recursive: true });
    await mkdir(join(FIXTURE_ROOT, "src"), { recursive: true });
    await writeFile(join(FIXTURE_ROOT, "tsconfig.json"), "{}\n", "utf8");
    await writeFile(
      join(FIXTURE_ROOT, "scripts", "postinstall.mjs"),
      await readFile(join(REPO_ROOT, "scripts", "postinstall.mjs"), "utf8"),
      "utf8",
    );

    const deployer = `
      import { existsSync, writeFileSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      const root = fileURLToPath(new URL("../..", import.meta.url));
      if (!existsSync(fileURLToPath(new URL("../../dist/shared/index.js", import.meta.url)))) {
        process.exit(19);
      }
      writeFileSync(fileURLToPath(new URL("./ran", import.meta.url)), "yes");
    `;
    await writeFile(join(FIXTURE_ROOT, "scripts", "audit", "postinstall.mjs"), deployer, "utf8");
    await writeFile(
      join(FIXTURE_ROOT, "scripts", "remediate", "postinstall.mjs"),
      deployer,
      "utf8",
    );

    const fakeNpmCli = join(FIXTURE_ROOT, "fake-npm-cli.mjs");
    await writeFile(
      fakeNpmCli,
      `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        if (process.argv.slice(2).join(" ") !== "run build") process.exit(23);
        mkdirSync(join(process.cwd(), "dist", "shared"), { recursive: true });
        writeFileSync(join(process.cwd(), "dist", "shared", "index.js"), "export {};\\n");
      `,
      "utf8",
    );

    // Windows treats environment keys case-insensitively. npm may contribute an
    // differently-cased NPM_EXECPATH entry; leaving both lets child_process pick
    // the inherited real npm CLI instead of this fixture's build seam.
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.toLowerCase() === "npm_execpath") delete childEnv[key];
    }
    childEnv.npm_execpath = fakeNpmCli;

    const result = spawnSyncHidden(
      process.execPath,
      [join(FIXTURE_ROOT, "scripts", "postinstall.mjs")],
      {
        cwd: FIXTURE_ROOT,
        env: { ...childEnv, INIT_CWD: FIXTURE_ROOT },
        encoding: "utf8",
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr ?? "").toBe(0);
    expect(result.stdout).toContain("building shared output for this source checkout");
    await expect(readFile(join(FIXTURE_ROOT, "scripts", "audit", "ran"), "utf8")).resolves.toBe(
      "yes",
    );
    await expect(
      readFile(join(FIXTURE_ROOT, "scripts", "remediate", "ran"), "utf8"),
    ).resolves.toBe("yes");
  });
});
