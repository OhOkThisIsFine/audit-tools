import { describe, expect, it } from "vitest";

import {
  extractFrameworkRouteEvidence,
  extractRegisteredRouteEvidence,
} from "../../src/audit/extractors/graphRoutes.js";

/**
 * Super-linear backtracking in the framework-route patterns
 * (`docs/reviews/analysis-tools-plan-2026-08-07.md` §4/§5): no regex over
 * unbounded audited-repo content may be super-linear on adversarial input.
 *
 * Probing all sixteen patterns at the six named sites against fourteen
 * adversarial families confirmed THREE in this module, and every one of them
 * took the same shape: an unbounded gap between two literals, quadratic because
 * a FAILING start position had to be expanded to the end before it could be
 * known to fail. Here they are `ANGULAR_LAZY_IMPORT_PATTERN`'s `[\s\S]*?` gap
 * between the route key and `import(`, and — in `extractImportBindings` — the
 * `[^;"'](?:[^;]*?)` clause gap and the `[^}]+` destructuring body, which no
 * longer exist as regexes at all (they are the `scanImportClauses` /
 * `scanRequireDestructuring` hand-scans). The comment here previously said ONE,
 * which was true of the patterns then in the file and stopped being true when
 * the binding clause was recognized as the same defect; the tests below cover
 * the other two through the same production entry point.
 *
 * The binding-clause pair is NOT an exception to the rule the header states, but
 * it is no longer an INSTANCE of it either: the fix for those two was to stop
 * running a regex over repo content at all, so the property here is that the
 * scan is linear, not that the pattern is bounded. A future pattern added to
 * this module is a fresh instance of the rule and is covered by the sibling
 * suite above; the two scans below need their own cases precisely because no
 * regex remains for that suite to time.
 *
 * ⚠ The adversarial input class is NOT "a file that repeats the marker". It is
 * whatever `collectAngularRoutes` hands the pattern, and that is one
 * `ANGULAR_ROUTE_OBJECT_PATTERN` body — `\{[^{}]*?path:…[^{}]*?\}`, a shape that
 * cannot contain a brace and is therefore unbounded in LENGTH. A marker-repeating
 * file with no `{…path:…}` object never reaches the pattern at all, so a test
 * written on that shape passes with the bug present and proves nothing (it was:
 * 2ms before the correction and 2ms after). The fixtures below therefore build
 * ONE route object with a long marker run and no `import(` — the reachable
 * quadratic, measured at 3.6/10.7/45.2/181.1ms across 2k/4k/8k/16k markers with
 * the unbounded gap, and 4.4ms at 16k bounded.
 *
 * Timing assertions are deliberate here — see the sibling test in
 * `tests/remediate/change-classification-backtracking.test.ts` for why this
 * input class warrants one: the separation is two orders of magnitude, so the
 * assertion detects an asymptotic regression rather than a constant factor.
 */

/**
 * A single Angular route object holding `markerCount` repeats of the lazy-import
 * key and NO `import(` anywhere. Every start position inside the gap must scan
 * to the end of the object and fail — the quadratic the bound removes.
 */
function routeObjectSource(markerCount: number): string {
  return [
    "import { Routes } from '@angular/router';",
    "export const routes: Routes = [",
    `  { path: 'far', ${"loadChildren:".repeat(markerCount)} },`,
    "];",
  ].join("\n");
}

function elapsedMsOf(run: () => void): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

describe("framework route extraction is linear on adversarial input", () => {
  it("scans a long route object without quadratic backtracking", () => {
    // Pre-correction the 16k-marker object took ~181ms and grew 4x per doubling;
    // bounded it is ~5ms. The ceiling sits an order of magnitude above the fixed
    // figure and 3x below the broken one.
    const content = routeObjectSource(16_000);
    expect(content.length).toBeGreaterThan(200_000);
    const elapsed = elapsedMsOf(() =>
      extractFrameworkRouteEvidence("src/app/routes.ts", content, new Map()),
    );
    expect(
      elapsed,
      `scanning a ${content.length}-char route object took ${elapsed.toFixed(1)}ms`,
    ).toBeLessThan(60);
  });

  it("grows linearly, not quadratically, across a doubling", () => {
    const smallMs = elapsedMsOf(() =>
      extractFrameworkRouteEvidence("src/app/routes.ts", routeObjectSource(8_000), new Map()),
    );
    const largeMs = elapsedMsOf(() =>
      extractFrameworkRouteEvidence("src/app/routes.ts", routeObjectSource(16_000), new Map()),
    );
    // Linear doubles (~2.0 measured both bounded and across the whole scan);
    // quadratic quadruples (~4.0 measured with the unbounded gap).
    expect(
      largeMs,
      `8k=${smallMs.toFixed(2)}ms 16k=${largeMs.toFixed(2)}ms`,
    ).toBeLessThan(Math.max(smallMs * 3, 30));
  }, 120_000);

  it("still resolves a real lazy import inside the bounded window", () => {
    // The correction must not cost the shape it exists to read: a genuine
    // `loadChildren: () => import('./x')` sits ~20 characters from the key, far
    // inside the 200-character window.
    const source = [
      "import { Routes } from '@angular/router';",
      "export const routes: Routes = [",
      "  { path: 'lazy', loadChildren: () => import('./lazy/lazy.module').then(m => m.LazyModule) },",
      "];",
    ].join("\n");
    const pathLookup = new Map([["src/app/lazy/lazy.module.ts", "src/app/lazy/lazy.module.ts"]]);
    const { calls } = extractFrameworkRouteEvidence("src/app/routes.ts", source, pathLookup);
    expect(calls.map((call) => call.reason).join("\n")).toContain("lazy");
  });

  it("does not resolve across a gap wider than the window", () => {
    // The documented boundary of the bound: a key separated from its `import(` by
    // more than 200 characters is no longer read. That is the deliberate
    // leads-not-verdicts trade — a dropped exotic form over an unbounded scan —
    // and it is asserted here so the limit is stated rather than discovered. The
    // route itself is still emitted; only the HANDLER stays unresolved.
    // No braces in the filler: the route object is `[^{}]*`, so an inner brace
    // would drop the object entirely and the test would prove nothing about the
    // window.
    const filler = "// ".padEnd(300, "x");
    const source = [
      "import { Routes } from '@angular/router';",
      "export const routes: Routes = [",
      `  { path: 'far', loadChildren: () => ${filler} import('./far/far.module') },`,
      "];",
    ].join("\n");
    const pathLookup = new Map([["src/app/far/far.module.ts", "src/app/far/far.module.ts"]]);
    const { calls, routes } = extractFrameworkRouteEvidence("src/app/routes.ts", source, pathLookup);
    expect(calls.map((call) => call.reason).join("\n")).not.toContain("far.module");
    expect(routes.map((route) => route.path)).toContain("/far");
  });
});

/**
 * The two BINDING-CLAUSE sites — the ones the sibling suite above does not reach.
 *
 * Both are read by `extractImportBindings`, which runs at the top of
 * `extractRegisteredRouteEvidence` before any route pattern does (`.ts`/`.tsx`
 * only), so the production entry point is the whole reach: the fixture is a
 * source file whose only content is the adversarial marker run.
 *
 * Neither family repeats a marker the PATTERN looks for. `"import "×n` has no
 * `from`, and `const {×n` has no `}` at all — so both are exactly the shape that
 * forces an unbounded gap to expand to the end of the file from every start
 * position, which is the quadratic. A file repeating the marker in a form that
 * COMPLETES (a well-formed import) is linear under the old regex too, so a test
 * written on that shape passes with the bug present and proves nothing.
 *
 * The assertion is a RATIO ACROSS A DOUBLING, with the same floor the sibling
 * suite uses: linear doubles, quadratic quadruples, and the floor keeps a loaded
 * runner's noise on a sub-millisecond small case from making the ratio noise.
 */
function importClauseSource(markerCount: number): string {
  return `export const routes = 0;\n${"import ".repeat(markerCount)}`;
}

function destructuringSource(markerCount: number): string {
  return `export const routes = 0;\n${"const { ".repeat(markerCount)}`;
}

/**
 * Time the same measurement at 40k and 80k markers.
 *
 * Both sizes are measured TWICE and the smaller of the two is used, because a
 * loaded runner produces a slow outlier and a growth test must not read one as
 * asymptotics. The warm-up call is discarded entirely: first-call JIT tier-up
 * would otherwise be billed to whichever size ran first.
 */
function doubling(
  measure: (markerCount: number) => void,
): { smallMs: number; largeMs: number } {
  measure(40_000);
  const times = (markerCount: number) => [elapsedMsOf(() => measure(markerCount)), elapsedMsOf(() => measure(markerCount))];
  const small = times(40_000);
  const large = times(80_000);
  return { smallMs: Math.min(...small), largeMs: Math.min(...large) };
}

describe("the import-binding clause scan is linear on adversarial input", () => {
  it("scans a marker run with no completing `from` without quadratic backtracking", () => {
    const { smallMs, largeMs } = doubling((markers) =>
      extractRegisteredRouteEvidence(
        "src/app/routes.ts",
        importClauseSource(markers),
        new Map(),
      ),
    );
    expect(
      largeMs,
      `40k=${smallMs.toFixed(2)}ms 80k=${largeMs.toFixed(2)}ms`,
    ).toBeLessThan(Math.max(smallMs * 3, 30));
  }, 120_000);

  it("still reads every binding a well-formed clause declares", () => {
    // The scan must not cost the shapes it exists to read.
    const source = [
      "import * as ns from './ns';",
      "import { b as c } from './named';",
      "app.get('/b', ns);",
      "app.get('/c', c);",
    ].join("\n");
    const lookup = new Map(
      ["src/app/ns.ts", "src/app/named.ts"].map((path) => [path, path]),
    );
    const { calls } = extractRegisteredRouteEvidence(
      "src/app/routes.ts",
      source,
      lookup,
    );
    // `calls[].to` is the RESOLVED target; the reason string carries the raw
    // specifier, so asserting on it would pass for a binding that resolved to
    // nothing.
    const targets = calls.map((call) => call.to);
    expect(targets, "a namespace clause must still resolve").toContain("src/app/ns.ts");
    expect(targets, "an aliased named clause must still resolve").toContain("src/app/named.ts");
  });
});

describe("the destructuring-require scan is linear on adversarial input", () => {
  it("scans a marker run with no closing brace without quadratic backtracking", () => {
    const { smallMs, largeMs } = doubling((markers) =>
      extractRegisteredRouteEvidence(
        "src/app/routes.ts",
        destructuringSource(markers),
        new Map(),
      ),
    );
    expect(
      largeMs,
      `40k=${smallMs.toFixed(2)}ms 80k=${largeMs.toFixed(2)}ms`,
    ).toBeLessThan(Math.max(smallMs * 3, 30));
  }, 120_000);

  it("still reads every destructured require binding", () => {
    const source = [
      "const { a } = require('./one');",
      "const { b, c: d } = require('./two');",
      "app.get('/a', a);",
      "app.get('/d', d);",
    ].join("\n");
    const lookup = new Map(
      ["src/app/one.ts", "src/app/two.ts"].map((path) => [path, path]),
    );
    const { calls } = extractRegisteredRouteEvidence(
      "src/app/routes.ts",
      source,
      lookup,
    );
    const targets = calls.map((call) => call.to);
    expect(targets, "a single destructured binding must still resolve").toContain("src/app/one.ts");
    expect(targets, "an aliased destructured binding must still resolve").toContain("src/app/two.ts");
  });
});
