# Tool Runbook: Code Duplication & Complexity Analysis

**Date:** 2026-09-05  
**Scope:** `audit-tools` development tree (`src/**/*.ts`, `scripts/**/*.mjs`, `tests/**/*.ts`).  
**Audience:** Maintainers, autonomous coding agents, and audit operators running duplication and complexity analysis.

---

## 1. Environment & Safe Isolation Protocol

This repository contains strict pre-commit gates, git hooks, and doc-manifest checkers. Heavy multi-tool analysis sweeps generate ephemeral reports, custom linter configurations, and raw telemetry that must **never** be committed to `main` or left dirty in the working tree.

### The Isolated Worktree Protocol (Mandatory for Sweeps)
Always execute multi-tool sweeps in an isolated Git worktree:

```bash
# 1. Create isolated worktree on a dedicated branch
git worktree add .claude/worktrees/analysis-sweep -b analysis-sweep

# 2. Enter the worktree
cd .claude/worktrees/analysis-sweep

# 3. (Windows) Create a junction to root node_modules (instant; avoids npm install)
cmd /c mklink /J node_modules C:\Code\audit-tools\node_modules

# 4. Create local results directory
mkdir analysis-results
```

### Safe Teardown Protocol
When analysis completes, tear down the worktree cleanly:
```bash
# 1. (Windows) CRITICAL: Delete junction first so git does NOT wipe root node_modules
cmd /c rmdir C:\Code\audit-tools\.claude\worktrees\analysis-sweep\node_modules

# 2. Remove worktree and delete ephemeral branch from repository root
cd C:\Code\audit-tools
git worktree remove .claude/worktrees/analysis-sweep --force
git branch -D analysis-sweep
```

---

## 2. Tool 1: `jscpd` (Token-Based Clone Detection — Types 1 & 2)

### What It Measures
Rabin-Karp token-matching across source files. Disregards whitespace and comments, identifying exact statement clones (Type 1) and literal/identifier renaming within identical statement sequences (Type 2).

### Current CI Configuration
* **Config file:** [`.jscpd.json`](file:///c:/Code/audit-tools/.jscpd.json)
* **Gate command:** `npm run check:dup` (registered in `verify:checks`)
* **Baseline & Ratchet:** Ratchet is set to **5.5%** of scanned lines (baseline at adoption 4.9%; currently measured at **4.59%** across 1,058 files).
* **Reporters:** Set to `["silent"]` in `.jscpd.json` so only breach exits non-zero.

### Calibration Recipes

#### Recipe A: Full Interactive Investigation (When a Ratchet Breaches)
```bash
npx jscpd --reporters consoleFull src scripts tests
```
*Prints side-by-side colorized source diffs for every duplicate region exceeding threshold.*

#### Recipe B: Calibrated Type-2 Sweep (Excluding Test Noise)
```bash
npx jscpd --config .jscpd.json \
  --min-tokens 40 \
  --min-lines 10 \
  --reporters json \
  --output analysis-results/jscpd-type2 \
  src scripts
```
* **Why `--min-tokens 40`:** Suppresses trivial 2-line getter/setter or guard boilerplate.
* **Why excluding `tests`:** Test fixture scaffolding and step assertions are accepted duplicate shapes; scanning `src` and `scripts` isolates production drift.

#### Recipe C: Suppressing Legitimate Duplication in Code
Wrap accepted duplication (e.g. lookup tables, generated constants) in comment pragmas:
```typescript
/* jscpd:ignore-start */
const RIPGREP_FLAG_TABLE = [ ... ];
/* jscpd:ignore-end */
```

---

## 3. Tool 2: `@kongyo2/similarity-ts` (AST Similarity — Types 2 & 3)

### What It Measures
Dedicated TypeScript AST comparator. Parses TypeScript syntax trees to detect:
1. **Function mode:** Functions sharing structural AST shape and control flow, regardless of variable/parameter names.
2. **Overlap mode:** Sliding-window token and AST node sequences matching across different files (gapped/near-miss Type 3 clones).

### Calibration Recipes

#### Recipe A: Type 2 Parameterized Function Sweep
```bash
npx similarity-ts src \
  --modes functions \
  --threshold 0.85 \
  --min-lines 15 \
  --format json \
  --output analysis-results/similarity-functions.json \
  --exclude "tests/**"
```
* **Calibration Rule 1 (`--threshold 0.85`):** The default `0.90` is too strict for renamed code with minor type annotation variations. `0.85` successfully catches twin logic (such as the `deriveObligationState` twin).
* **Calibration Rule 2 (`--min-lines 15`):** Suppresses small utility wrappers.
* **Calibration Rule 3 (`--exclude "tests/**"`):** Essential. Test oracle assertion bodies must not be compared against production code.

#### Recipe B: Type 3 Structural Overlap Sweep
```bash
npx similarity-ts src/shared src/audit src/remediate \
  --modes overlap \
  --format json \
  --output analysis-results/similarity-overlap.json \
  --overlap-min-window 12 \
  --overlap-max-window 24 \
  --overlap-size-tolerance 0.25
```
* **Calibration Rule 1 (`--overlap-min-window 12`):** Below 10 tokens generates hundreds of hits on standard Zod object schema fields (`z.string().optional()`). 12 tokens focuses on executable control flow blocks.
* **Calibration Rule 2 (`--overlap-max-window 24`):** Caps window expansion to avoid memory bloat across large monolith files.
* **Calibration Rule 3 (`--overlap-size-tolerance 0.25`):** Permits 25% length divergence, capturing cases where extra statements (assertions, error logging) were inserted.

---

## 4. Tool 3: `eslint-plugin-sonarjs` (Cognitive Complexity & Exact Functions)

### What It Measures
1. `sonarjs/no-identical-functions`: Exact AST body equality (already in zero-tolerance CI gate).
2. `sonarjs/cognitive-complexity`: Campbell's Cognitive Complexity metric. Unlike McCabe's Cyclomatic Complexity (which blindly counts decision points), Cognitive Complexity penalizes:
   * Nested control flow (if inside loop inside try/catch $= +1 + 2 + 3$).
   * Breaks in linear reading flow (jumps, recursions, boolean expressions with mixed operators).

### Why the Recommended Preset is BANNED
As documented in [`analysis-tools-plan-2026-08-07.md`](file:///c:/Code/audit-tools/docs/reviews/analysis-tools-plan-2026-08-07.md), running `plugin:sonarjs/recommended` blanketly produces 1,366 errors dominated by rules that are **actively harmful** to this repository:
* `sonarjs/no-alphabetical-sort`: Demands `localeCompare`, which is locale-dependent and **breaks deterministic array sorting** (`CLAUDE.md` invariant).
* `regex-perf` family: False-positives on standard idiomatic classes (`[A-Za-z_]`).

### Calibration Recipe: On-Demand Cognitive Complexity Leaderboard
To run an advisory sweep without altering [`eslint.config.js`](file:///c:/Code/audit-tools/eslint.config.js):

1. Create a local overlay file `eslint.complexity.config.js` in your worktree:
```javascript
import baseConfig from "./eslint.config.js";
import sonarjs from "eslint-plugin-sonarjs";

export default [
  ...baseConfig,
  {
    files: ["src/**/*.ts"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 20],
    },
  },
];
```

2. Run ESLint outputting JSON:
```bash
npx eslint -c eslint.complexity.config.js --format json -o analysis-results/eslint-cognitive-complexity.json src
```

3. Extract and rank the leaderboard:
```bash
node -e '
const fs = require("fs");
const report = JSON.parse(fs.readFileSync("analysis-results/eslint-cognitive-complexity.json", "utf8"));
const list = [];
for (const f of report) {
  for (const m of f.messages) {
    if (m.ruleId === "sonarjs/cognitive-complexity") {
      const match = m.message.match(/(\d+)/);
      list.push({ file: f.filePath.replace(/^.*src[\\\/]/, "src/"), line: m.line, score: match ? parseInt(match[0], 10) : 0 });
    }
  }
}
list.sort((a,b) => b.score - a.score);
list.slice(0, 20).forEach((item, i) => console.log(`${i+1}. [CC ${item.score}] ${item.file}:${item.line}`));
'
```

---

## 5. Tool 4: `dependency-cruiser` (Architectural Coupling & Instability)

### What It Measures
Module graph dependencies, circular edges, and Martin's package coupling metrics:
* **Afferent Coupling ($Ca$):** Number of external modules that depend on this module (incoming edges). High $Ca =$ core substrate.
* **Efferent Coupling ($Ce$):** Number of external modules this module depends upon (outgoing edges). High $Ce =$ integration coordinator.
* **Instability Index ($I$):** $I = \frac{Ce}{Ca + Ce}$. Ranges from 0 (maximally stable / hard to change) to 1 (maximally instable / easy to break).

### Calibration Recipes

#### Recipe A: Standard CI Gate (Zero Runtime Cycles)
```bash
npm run check:depgraph
# executes: depcruise --config .dependency-cruiser.cjs src
```

#### Recipe B: Extracting Full Architectural Metrics
```bash
npx depcruise --config .dependency-cruiser.cjs --output-type json src > analysis-results/depcruise-raw.json
```
* **Filtering Type-Only Cycles:** `.dependency-cruiser.cjs` already calibrates `viaOnly: dependencyTypesNot type-only`. Do not remove this: TypeScript erases type-only imports at runtime, so type cycles do not produce runtime initialization deadlocks.

---

## 6. Tool 5: `scripts/check-shared-primitives.mjs` (Type 4 Single-Source Gate)

### What It Measures
Enforces single-source ownership for tiny, high-risk shared primitives across all `src/**/*.ts`. Detects semantic clones of:
* Code-unit comparator bodies (`x < y ? -1 : x > y ? 1 : 0`).
* Root-containment path checks (`.startsWith("..")` + `relative(`).
* Inline SHA-256 hash chains (`createHash('sha256')`).
* Banned deleted-fork names (`isPlainObject`, `toPosix`, `posixify`, `compareIds`).

### Execution
```bash
node scripts/check-shared-primitives.mjs
```
* **Adding a New Rule:** Open [`scripts/check-shared-primitives.mjs`](file:///c:/Code/audit-tools/scripts/check-shared-primitives.mjs) and register either:
  1. A name entry in `SINGLE_DEFINITION_RULES` (`{ name: 'newHelper', home: 'src/shared/...' }`).
  2. A pattern ban in `PATTERN_RULES` with a regex matching the semantic body.

---

## 7. Tool 6: Behavioral Technical Debt Hotspots (Git Churn $\times$ Complexity)

### What It Measures
Cross-references **Git commit frequency (90 days)** with **Cognitive Complexity**. Identifies the exact files where high complexity creates active maintenance bugs.

### Execution Script
Run this one-liner inside your worktree after generating `eslint-cognitive-complexity.json`:

```bash
node -e '
const { execSync } = require("child_process");
const fs = require("fs");

const churnRaw = execSync("git log --since=\"90 days ago\" --name-only --format=\"\" src/", { encoding: "utf8" });
const churnMap = {};
for (const line of churnRaw.split(/\r?\n/)) {
  const trimmed = line.trim().replace(/\\/g, "/");
  if (trimmed.endsWith(".ts")) churnMap[trimmed] = (churnMap[trimmed] || 0) + 1;
}

const report = JSON.parse(fs.readFileSync("analysis-results/eslint-cognitive-complexity.json", "utf8"));
const compMap = {};
for (const f of report) {
  const rel = f.filePath.replace(/^.*src[\\\/]/, "src/").replace(/\\/g, "/");
  let max = 0, sum = 0;
  for (const m of f.messages) {
    if (m.ruleId === "sonarjs/cognitive-complexity") {
      const match = m.message.match(/(\d+)/);
      const score = match ? parseInt(match[0], 10) : 0;
      if (score > max) max = score;
      sum += score;
    }
  }
  if (max > 0) compMap[rel] = { max, sum };
}

const hotspots = [];
for (const [file, comp] of Object.entries(compMap)) {
  const churn = churnMap[file] || 1;
  hotspots.push({ file, churn, max: comp.max, sum: comp.sum, score: churn * comp.max });
}
hotspots.sort((a,b) => b.score - a.score);

console.log("=== TOP 10 REFACTORING HOTSPOTS ===");
hotspots.slice(0, 10).forEach((h, i) => {
  console.log(`${i+1}. [Score: ${h.score}] ${h.file} (Churn: ${h.churn} | Max CC: ${h.max} | Sum CC: ${h.sum})`);
});
'
```

---

## 8. Summary Calibration Matrix

| Tool | Target Clone / Metric | Recommended Flags | Exclusions / Calibrations |
|---|---|---|---|
| **`jscpd`** | Type 1, Type 2 | `--min-tokens 40 --min-lines 10` | Exclude `tests/**` and generated schemas |
| **`similarity-ts` (functions)** | Type 2 Parameterized | `--threshold 0.85 --min-lines 15` | Exclude `tests/**`, barrels, and lookup tables |
| **`similarity-ts` (overlap)** | Type 3 Structural | `--overlap-min-window 12 --overlap-max-window 24` | Tolerance 0.25; target `src/{audit,remediate,shared}` |
| **`sonarjs` (cognitive)** | Cognitive Complexity | Threshold $\ge 20$, advisory only | Suppress `tests/**`; do not enable blanket recommended preset |
| **`dependency-cruiser`** | Architecture / Coupling | `--output-type json` | Tolerate `viaOnly: dependencyTypesNot type-only` |
| **`check-shared-primitives`**| Type 4 Single-Source | Direct node execution | Tracked `src/**/*.ts` only |
| **Hotspot Analyzer** | Churn $\times$ Complexity | 90-day git window | Correlate git log frequency with max function CC |
