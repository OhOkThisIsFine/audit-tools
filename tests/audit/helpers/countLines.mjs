import { join } from "node:path";
import { countLines as countLinesImpl } from "../../../src/audit/cli/args.js";

/**
 * Count the lines of the file at `join(root, relativePath)` — by calling the
 * PRODUCTION counter, never a copy of it.
 *
 * This used to be a local re-implementation (`readFile` + `split(/\r?\n/)`) of
 * `src/audit/cli/args.ts`'s streaming `countLines`. The convention it copied —
 * "a trailing newline does not count as an extra line, an empty file is 0" — is
 * exactly what `file_coverage[].total_lines` is checked against, so the two
 * implementations had to agree forever while nothing made them. A second copy
 * is a copy that drifts, and it would have drifted silently: the fixtures here
 * exist to satisfy the auditor's own line-count rule, so a divergence would have
 * made the fixtures wrong rather than the tests red.
 *
 * `tests/shared/test-mirrors-production.test.ts` is the invariant that keeps a
 * third copy from appearing.
 */
export async function countLines(root, relativePath) {
  return countLinesImpl(join(root, relativePath));
}
