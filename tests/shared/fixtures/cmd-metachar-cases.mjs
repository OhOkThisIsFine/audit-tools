// Shared nasty-arg fixture for cmd.exe `.cmd`/`.bat` shim-wrapping quoting
// (CVE-2024-27980 class). Single-sourced between:
//   - tests/shared/exec.test.mjs           (asserts exact expected output
//     against src/shared/tooling/exec.ts's quoteForCmd)
//   - tests/shared/wrapper-quote-parity.test.mjs (asserts the wrapper's
//     byte-mirrored copy behaves identically to the shared implementation)
// Not a `*.test.mjs` file itself, so vitest's `tests/shared/**/*.test.mjs`
// include glob does not collect it as a suite.
export const CMD_METACHAR_CASES = [
  { arg: "a&b", expected: "a^&b" },
  { arg: "a|b", expected: "a^|b" },
  { arg: "a<b>c", expected: "a^<b^>c" },
  { arg: "a^b", expected: "a^^b" },
  { arg: 'a"b', expected: '"a""b"' },
  { arg: "a b", expected: '"a b"' },
  { arg: "", expected: '""' },
];

export const CMD_PERCENT_CASES = ["%PATH%", "a%b"];
