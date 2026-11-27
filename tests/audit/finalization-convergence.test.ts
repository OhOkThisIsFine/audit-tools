import { test, expect } from "vitest";
import { loadArtifactBundle, writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { hashArtifactValue } from "../../src/shared/artifactFreshness.js";
import { withTempDir } from "./helpers/withTempDir.mjs";

// Fix: writeCoreArtifacts must remove files for artifacts an executor cleared to
// `undefined` when pruning, or they reload as stale "present" artifacts.
test("writeCoreArtifacts prunes cleared artifacts only when asked", async () => {
  await withTempDir("audit-code-finalization-", async (dir) => {
    const repoManifest = { repository: { name: "t" }, generated_at: "t", files: [] };
    await writeCoreArtifacts(dir, {
      repo_manifest: repoManifest,
      audit_report: "# Report\n",
    });
    expect((await loadArtifactBundle(dir)).audit_report).toBe("# Report\n");

    // Default (no prune): a cleared artifact lingers on disk.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest });
    expect((await loadArtifactBundle(dir)).audit_report).toBe("# Report\n");

    // prune: the cleared artifact is removed; pruning a missing file is a no-op.
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
    expect((await loadArtifactBundle(dir)).audit_report).toBe(undefined);
    await writeCoreArtifacts(dir, { repo_manifest: repoManifest }, { prune: true });
  });
});

// Fix: a rebuilt artifact's wall-clock generated_at is provenance, not content;
// it must not change the metadata content hash (else its revision churns and
// perpetually re-stales downstreams).
test("metadata content hash ignores generated_at for rebuilt timestamped artifacts", () => {
  for (const name of ["design_assessment.json", "repo_manifest.json"]) {
    expect(hashArtifactValue(name, { generated_at: "2026-01-01T00:00:00Z", data: 1 }), `${name} hash should ignore generated_at`).toBe(hashArtifactValue(name, { generated_at: "2026-12-31T23:59:59Z", data: 1 }));
  }
  expect(hashArtifactValue("design_assessment.json", { data: 1 })).not.toBe(hashArtifactValue("design_assessment.json", { data: 2 }));
});
