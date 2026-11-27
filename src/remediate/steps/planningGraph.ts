// sites-pinned: tests/remediate/planning-graph.test.ts
import { dirname, join } from "node:path";
import { auditArtifactsDir, hashContent, readOptionalTextFile, writeTextFile } from "audit-tools/shared";
import { errorMessage } from "../../shared/io/json.js";
import { readWorkingAuditNavigationGraph } from "../../audit/io/artifacts.js";
import { auditNavigationGraphPath, navigationSourceDigest } from "../../audit/io/navigationGraph.js";
import { buildReviewerGraph, readReviewGraphSourceDigest } from "../../audit/cli/reviewGraphCommand.js";
import { renderAuditCommand } from "../../audit/cli/prompts.js";
import { buildFileDisposition } from "../../audit/extractors/disposition.js";
import { buildRepoManifestFromFs } from "../../audit/extractors/fsIntake.js";
import { buildGraphBundleFromFs } from "../../audit/extractors/graph.js";
import { loadIgnoreFile } from "../../audit/extractors/ignore.js";

interface PlanningGraphOptions { root: string; artifactsDir: string }

export async function preparePlanningGraph({ root, artifactsDir }: PlanningGraphOptions): Promise<string> {
  try {
    const manifest = await buildRepoManifestFromFs({ root, ignore: await loadIgnoreFile(root), hash_files: true });
    const source = navigationSourceDigest(manifest.files);
    if (!source || !manifest.files.length) return "";
    const audit = auditArtifactsDir(root);
    const cachePath = join(artifactsDir, "planning-graph.json");
    let text: string | undefined;
    for (const read of [
      () => readWorkingAuditNavigationGraph(audit, source),
      () => readOptionalTextFile(auditNavigationGraphPath(dirname(audit))),
    ]) {
      const candidate = await read().catch(() => undefined);
      if (readReviewGraphSourceDigest(candidate) === source) { text = candidate; break; }
    }
    // The remediation phase lock serializes writers, so one snapshot serves both checks.
    const cachedText = await readOptionalTextFile(cachePath).catch(() => undefined);
    if (!text) {
      text = cachedText;
      if (readReviewGraphSourceDigest(text) !== source) {
        const disposition = await buildFileDisposition(manifest, { root });
        const bundle = await buildGraphBundleFromFs(manifest, root, disposition);
        // The extractor reads from the active remediation checkout. Do not
        // publish evidence if the bytes changed while it was being built.
        const check = await buildRepoManifestFromFs({ root, ignore: await loadIgnoreFile(root), hash_files: true });
        if (navigationSourceDigest(check.files) !== source) return "\nDependency navigation unavailable: source changed during graph extraction. Inspect source directly.\n";
        text = buildReviewerGraph(bundle, manifest.files.map(file => file.path), undefined, source);
      }
    }
    if (text === undefined) return "";
    if (cachedText !== text) await writeTextFile(cachePath, text);
    const command = renderAuditCommand(["review-graph", "--graph-index", cachePath, "--graph-sha256", hashContent(text), "--path", "REPO_RELATIVE_PATH"]);
    return `\nDependency navigation: run \`${command}\` on demand. Replace REPO_RELATIVE_PATH with a repository-relative path. These file links are hints; verify affected callers and boundaries in source. Do not load the entire graph into context.\n`;
  } catch (error) {
    console.warn("[remediate-code] Dependency navigation unavailable: " + errorMessage(error));
    return "\nDependency navigation unavailable. Inspect source directly.\n";
  }
}
