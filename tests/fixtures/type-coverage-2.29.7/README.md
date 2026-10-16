# type-coverage adapter qualification

JSON captures were generated from the real type-coverage 2.29.7 CLI with TypeScript
5.9.3 on Node 24.19.0, using the accompanying source/config in a disposable project.
`any.json` uses `index.ts`; `clean.json` uses `export const first: number = 1;`;
`error.json` adds `--project missing.json` (the upstream spelling is retained).
All runs use the candidate flags:
`--json-output --detail --no-update --no-update-if-higher --no-history-file --no-cache`.
The any capture uses `showRelativePath: true` for portable fixture bytes.

The CLI pins its core dependency with a range: this recorded resolution uses
**type-coverage-core 2.30.4**, not 2.29.7. The full integrity-bearing lock preserves
that exact tested resolution; no claim is made about every possible core version.
No production dependency or acquisition spec is changed.

To repeat the real CLI contract test, create a disposable tools directory, copy
`tool-package.json` to `package.json` and `tool-package-lock.json` to
`package-lock.json`, and run `npm ci --ignore-scripts --no-audit --no-fund` there
(with an isolated HOME and npm cache). Set `AUDIT_TYPE_COVERAGE_TOOLS` to that
absolute directory and run `vitest run tests/shared/type-coverage-contract.test.ts`.
The test creates and deletes its own project, sibling sentinel directory and HOME.
It never invokes npm or scans the repository. Ordinary tests consume the saved
captures and do not require installing or running the acquired tool.
