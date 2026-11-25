import { expect, test } from "vitest";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../../src/shared/analyzers/candidates.js";
import { resolveAnalyzerRelease } from "../../src/shared/analyzers/latestVersion.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("a binary release binds checksum name, asset, and URL to one exact version", async () => {
  const gitleaks = EXTERNAL_ANALYZER_CANDIDATES.find(x => x.id === "gitleaks")!;
  const release = await resolveAnalyzerRelease(gitleaks, async url => {
    expect(url).toBe("https://api.github.com/repos/gitleaks/gitleaks/releases/latest");
    return encode({ tag_name: "v8.99.1" });
  }, 1_000);
  const binary = release?.candidate.binary;
  expect(binary?.version).toBe("8.99.1");
  expect(binary?.assetFor("linux", "x64")).toBe("gitleaks_8.99.1_linux_x64.tar.gz");
  expect(binary?.checksumsAsset).toBe("gitleaks_8.99.1_checksums.txt");
  expect(binary?.releaseUrlForAsset("asset")).toBe("https://github.com/gitleaks/gitleaks/releases/download/v8.99.1/asset");
});

test("latest type-coverage uses an isolated exact-version install, not the bundled old graph", async () => {
  const typeCoverage = EXTERNAL_ANALYZER_CANDIDATES.find(x => x.id === "type-coverage")!;
  const release = await resolveAnalyzerRelease(typeCoverage, async url => {
    expect(url).toBe("https://registry.npmjs.org/type-coverage/latest");
    return encode({ version: "2.99.0" });
  }, 1_000);
  expect(release).toMatchObject({ version: "2.99.0", candidate: {
    spec: "type-coverage@2.99.0",
    npmEntrypoint: "node_modules/type-coverage/bin/type-coverage",
  } });
  expect(release?.candidate.npmLock).toBeUndefined();
  await expect(resolveAnalyzerRelease(typeCoverage, async () => encode({ version: "latest" }), 1_000))
    .rejects.toThrow("not an exact stable release");
});
