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

test.each([undefined, "2.31.2"])("keeps type-coverage and its compiler qualified together (recorded: %s)", async recorded => {
  const typeCoverage = EXTERNAL_ANALYZER_CANDIDATES.find(x => x.id === "type-coverage")!;
  const release = await resolveAnalyzerRelease(typeCoverage, async () => {
    throw new Error("a qualified tuple must not query a floating release");
  }, 1_000, recorded);
  expect(release).toEqual({ version: "2.29.7", candidate: typeCoverage });
  expect(release?.candidate.npmLock?.lock.packages[""].dependencies).toEqual({
    "type-coverage": "2.29.7", typescript: "5.9.3",
  });
});

test("an unlocked npm analyzer still updates to an exact upstream release", async () => {
  const jscpd = EXTERNAL_ANALYZER_CANDIDATES.find(x => x.id === "jscpd")!;
  const release = await resolveAnalyzerRelease(jscpd, async url => {
    expect(url).toBe("https://registry.npmjs.org/jscpd/latest");
    return encode({ version: "4.99.0" });
  }, 1_000);
  expect(release).toMatchObject({ version: "4.99.0", candidate: { spec: "jscpd@4.99.0" } });
  await expect(resolveAnalyzerRelease(jscpd, async () => encode({ version: "latest" }), 1_000))
    .rejects.toThrow("not an exact stable release");
});
