import { join, resolve } from "node:path";

/**
 * Resolve the artifacts directory from command-line args or default to
 * <cwd>/.audit-tools/audit. The --artifacts-dir flag is optional; when omitted
 * or invalid, defaults to the standard location. Default must match where the
 * orchestrator/wrapper actually writes runs: <root>/.audit-tools/audit
 * (COR-bf5c7331) — the prior `.audit-artifacts` default resolved to a
 * directory the pipeline never populates.
 */
export function resolveArtifactsDir(argv, defaultDir = join(process.cwd(), ".audit-tools", "audit")) {
  const idx = argv.indexOf("--artifacts-dir");
  return idx !== -1 && argv[idx + 1] ? resolve(argv[idx + 1]) : defaultDir;
}
