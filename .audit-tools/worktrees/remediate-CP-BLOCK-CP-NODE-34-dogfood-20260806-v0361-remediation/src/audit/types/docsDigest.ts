/**
 * Deterministic docs digest (change 3, scope-confirmation context): a bounded
 * telos extraction over the repo's prose docs, rendered into the confirm-intent
 * prompt so the scope decider sees the repo's STATED purpose instead of
 * inferring it from path heuristics. Pure extraction — no LLM pass; the digest
 * is a leaf-consumer artifact (nothing downstream depends on it, and it must
 * never gain an edge into `intent_checkpoint.json`, which is a durable
 * host-input leaf whose revision mirrors the intent baseline).
 */
export interface DocsDigestEntry {
  /** Repo-relative posix path of the doc file. */
  path: string;
  /** First markdown ATX heading, or the file name when the doc has none. */
  title: string;
  /** Leading text of the doc, newline-normalized, capped (see extractor). */
  excerpt: string;
}

export interface DocsDigest {
  generated_at: string;
  /**
   * Digested docs, selection-ordered: shallowest path depth first, then
   * path-sorted (locale collation) — so root-level docs lead deterministically.
   */
  docs: DocsDigestEntry[];
  /**
   * Doc-universe files beyond the selection cap (path-sorted). Present only
   * when non-empty, so the render can say what was not digested rather than
   * implying full coverage.
   */
  omitted_paths?: string[];
}
