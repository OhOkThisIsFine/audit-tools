// Lint gate for the audit-tools DEV tree (`npm run check:lint`, wired into
// verify:checks). Curated, zero-tolerance ruleset — every rule here is an error
// and the tree is kept at zero, so a lint hit is always signal. This deliberately
// is NOT the recommended preset: the blanket sonarjs+ts-eslint recommended run
// (2026-08-07 analysis pass) produced 1,366 messages, most of them style
// opinions (cognitive-complexity, nested ternaries/templates) or rules that are
// actively wrong for this repo — sonarjs/no-alphabetical-sort asks for
// localeCompare, which is locale-DEPENDENT and would violate the deterministic
// stable-order invariant (CLAUDE.md "Extractors emit stable, content-derived
// array order"); the regex-perf family false-positives on idiomatic classes.
// Verified-real classes from that run are gated below; the judgment-level
// classes (complexity, regex-perf on unbounded input) are backlog work, not
// lint noise. Full triage record: docs/reviews/analysis-tools-plan-2026-08-07.md.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

// Real defect classes, verified against this tree at adoption.
const CORRECTNESS_RULES = {
  // Dead code that tsc (noUnusedLocals off) does not catch. `^_` is the
  // deliberate-discard convention.
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      args: "all",
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  // Two byte-identical functions are a drift hazard ("extract, don't
  // drift-test") — caught live at adoption (orchestrator.ts assert twins).
  "sonarjs/no-identical-functions": "error",
  // Assignments no path reads — caught live at adoption (state.ts, triage.ts).
  "sonarjs/no-dead-store": "error",
  "sonarjs/no-redundant-assignments": "error",
  // A collection that is filled but never read.
  "sonarjs/no-unused-collection": "error",
  // `continue`/`return` as the last statement of its block.
  "sonarjs/no-redundant-jump": "error",
};

export default [
  {
    // Generated, vendored, run-output and prose trees are not lintable surface.
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "analysis-results-*/**",
      ".audit-tools/**",
      ".audit-tools-profile/**",
      ".audit-artifacts/**",
      ".claude/**",
      "docs/**",
      "spec/**",
    ],
  },
  {
    // Product source — type-aware.
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { project: "./tsconfig.json" },
    },
    plugins: { "@typescript-eslint": tsPlugin, sonarjs },
    rules: CORRECTNESS_RULES,
  },
  {
    // Test tree — type-aware via the test tsconfig (the 2026-08-07 analysis run
    // pointed tests at tsconfig.json and silently linted NOTHING under tests/:
    // 589 parse errors read as coverage). sonarjs duplication rules are off
    // here — fixture boilerplate twins are accepted test shape.
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { project: "./tsconfig.test.json" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "@typescript-eslint/no-unused-vars": CORRECTNESS_RULES["@typescript-eslint/no-unused-vars"],
    },
  },
  {
    // The typechecker-invisible .mjs surface (scripts/, wrapper/, dispatch/,
    // bins, hooks-adjacent generators): no tsc safety net at all, so the core
    // correctness rules matter most here. Non-type-aware.
    files: ["scripts/**/*.mjs", "wrapper/**/*.mjs", "dispatch/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    plugins: { sonarjs },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-fallthrough": "error",
      "no-self-assign": "error",
      "no-constant-binary-expression": "error",
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-dead-store": "error",
      "sonarjs/no-unused-collection": "error",
    },
  },
];
