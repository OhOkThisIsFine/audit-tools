// One tarball, two packaged smokes.
//
// Both packaged smokes install the SAME single audit-tools package, and packing it
// (prepack build + tar) is the slowest step of `verify:checks`. Each smoke packing
// its own tarball doubled that step for zero extra coverage. These tests pin the
// invariant mechanically: the pack has ONE owner, a still-current tarball is reused
// rather than rebuilt, and anything that would change the tarball's contents forces
// a repack (so a reused tarball can never be a false green).

import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSmokeTarball } from "../../scripts/shared/smoke-tarball.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface PackageJson {
  scripts: Record<string, string>;
}

interface PackContext {
  repoRoot: string;
  cacheDir: string;
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
}

async function readScript(relPath: string): Promise<string> {
  return (await readFile(join(repoRoot, relPath), "utf8")).replace(/\r\n/g, "\n");
}

// A throwaway checkout whose shape mirrors the real one: a `files` list (what ships)
// and a tsconfig `include` (what prepack rebuilds into dist/) are the two config-derived
// input sets the freshness rule reads.
async function fakeCheckout() {
  const root = await mkdtemp(join(tmpdir(), "smoke-tarball-repo-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "smoke-tarball-cache-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "audit-tools", version: "9.9.9", files: ["dist/**", "README.md"] }),
  );
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
  await writeFile(join(root, "dist", "index.js"), "export const built = true;\n");
  await writeFile(join(root, "src", "index.ts"), "export const source = true;\n");
  await writeFile(join(root, "README.md"), "# fake\n");
  // Age every input so a tarball packed "now" is unambiguously newer — otherwise a
  // same-millisecond tie decides the test instead of the rule under test.
  const aged = new Date(Date.now() - 60_000);
  for (const rel of ["package.json", "tsconfig.json", "dist/index.js", "src/index.ts", "README.md"]) {
    await utimes(join(root, ...rel.split("/")), aged, aged);
  }
  return { root, cacheDir };
}

function countingPack() {
  const calls: Array<{ packRoot: string; cacheDir: string }> = [];
  const pack = ({ repoRoot: packRoot, cacheDir }: PackContext) => {
    calls.push({ packRoot, cacheDir });
    const tarballPath = join(cacheDir, "audit-tools-9.9.9.tgz");
    // The real packer writes the tarball via `npm pack --pack-destination`; the fake
    // stands in for that side effect so the resolver sees a real file to stat.
    writeFileSync(tarballPath, "tarball-bytes");
    return {
      tarballPath,
      metadata: { filename: "audit-tools-9.9.9.tgz", files: [{ path: "dist/index.js" }] },
    };
  };
  return { pack, calls };
}

describe("packaged smokes share one tarball", () => {
  test("the second consumer reuses the first consumer's tarball instead of repacking", async () => {
    const { root, cacheDir } = await fakeCheckout();
    const { pack, calls } = countingPack();

    const first = resolveSmokeTarball({ repoRoot: root, cacheDir, pack });
    const second = resolveSmokeTarball({ repoRoot: root, cacheDir, pack });

    expect(calls.length, "two packaged smokes must cost exactly one pack").toBe(1);
    expect(first.packed).toBe(true);
    expect(second.packed).toBe(false);
    expect(second.tarballPath).toBe(first.tarballPath);
    // The reusing consumer still needs the packed-file list to assert the shipped contract.
    expect(second.metadata).toEqual(first.metadata);
  });

  test("a changed input forces a repack, so a reused tarball is never stale", async () => {
    const { root, cacheDir } = await fakeCheckout();
    const { pack, calls } = countingPack();

    resolveSmokeTarball({ repoRoot: root, cacheDir, pack });
    const packedAt = statSync(join(cacheDir, "audit-tools-9.9.9.tgz")).mtimeMs;

    // A source edit that prepack would rebuild into dist/ — the cached tarball predates it.
    const newer = new Date(packedAt + 5_000);
    await utimes(join(root, "src", "index.ts"), newer, newer);
    const afterSourceEdit = resolveSmokeTarball({ repoRoot: root, cacheDir, pack });
    expect(afterSourceEdit.packed, "a src edit must invalidate the cached tarball").toBe(true);
    expect(calls.length).toBe(2);

    // A shipped-file edit — same rule, different input set.
    const later = new Date(statSync(join(cacheDir, "audit-tools-9.9.9.tgz")).mtimeMs + 5_000);
    await utimes(join(root, "README.md"), later, later);
    expect(resolveSmokeTarball({ repoRoot: root, cacheDir, pack }).packed).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("verify:checks packs once, ahead of both packaged smokes", async () => {
    const pkg = await readPackageJson();
    expect(pkg.scripts["pack:smoke"], "a single pack step must own the tarball").toBeTruthy();

    const chain = pkg.scripts["verify:checks"];
    const packIdx = chain.indexOf("pack:smoke");
    expect(packIdx >= 0, "verify:checks must run the shared pack step").toBe(true);
    for (const smoke of ["smoke:packaged-audit-code", "smoke:packaged-remediate-code"]) {
      expect(chain.indexOf(smoke) > packIdx, `${smoke} must run after the shared pack step`).toBe(true);
    }
  });

  test("neither packaged smoke owns an npm pack of its own", async () => {
    for (const relPath of [
      "scripts/audit/smoke-packaged-audit-code.mjs",
      "scripts/remediate/smoke-packaged-remediate-code.mjs",
    ]) {
      const source = await readScript(relPath);
      expect(source, `${relPath} must resolve its tarball through the shared pack`).toMatch(
        /resolveSmokeTarball/,
      );
      expect(source, `${relPath} must not spawn its own npm pack`).not.toMatch(
        /"pack",\s*"--json"/,
      );
    }
  });
});
