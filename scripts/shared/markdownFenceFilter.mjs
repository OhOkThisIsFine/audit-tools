// sites-pinned: tests/shared/backlog-status-tokens.test.ts, tests/shared/backlog-line-numbers.test.ts
/**
 * Sequential line filter for fenced examples in backlog Markdown. Keep the
 * guards' existing indented-fence support; a closer must match the opener's
 * marker and length, and cannot carry an info string.
 */
export function markdownFenceFilter() {
  let opener = null;
  return (line) => {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opener !== null) {
      if (match && match[1][0] === opener[0] && match[1].length >= opener.length && !match[2].trim()) {
        opener = null;
      }
      return true;
    }
    if (!match || (match[1][0] === "`" && match[2].includes("`"))) return false;
    opener = match[1];
    return true;
  };
}
