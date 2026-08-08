// The ONE definition of "a backlog entry", shared by the budget gate
// (scripts/check-backlog-budget.mjs) and the roadmap/seek-index generators
// (scripts/shared/generate-handoff-roadmap.mjs). Both files previously carried a
// byte-identical copy of this segmentation loop, kept honest by a drift test that
// compared their entry COUNTS — one grammar removes the need for either.
//
// What is deliberately NOT shared: how each consumer derives an entry's title.
// The budget gate's title is a PERSISTED identity — `entryKey()` writes it into
// docs/backlog/.size-baseline.json, where the recorded keys carry its 78-char
// truncation. The roadmap needs the verbatim multi-line bold run instead. Making
// those one function would silently invalidate every grandfathered baseline key.

/**
 * Split backlog text into its top-level entries. An entry opens with a column-0
 * `- **` bullet and runs to the next one (nested bullets and continuation lines
 * belong to the entry above them).
 *
 * @param {string} text
 * @returns {{line: number, headline: string, body: string}[]}
 *   `line` is 1-indexed; `headline` is the opening line alone; `body` is the
 *   entry's full text including its continuation lines.
 */
export function splitBacklogEntries(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    if (/^- \*\*/.test(l)) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return {
      line: start + 1,
      headline: lines[start],
      body: lines.slice(start, end).join("\n"),
    };
  });
}
