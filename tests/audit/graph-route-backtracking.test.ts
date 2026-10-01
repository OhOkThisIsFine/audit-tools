import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
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
 * Hard subprocess deadlines below bound pathological regressions while allowing
 * ordinary CI scheduling noise; semantic assertions prove the public extractor ran.
 */

describe("framework route extraction is linear on adversarial input", () => {
  it("scans growing route objects in a bounded subprocess and preserves their paths", () => {
    // A hard process ceiling bounds regressions without 60ms scheduler-sensitive
    // assertions. The former unbounded lazy-import gap exceeds this ceiling at
    // 200k markers; the bounded extractor handles all three sizes comfortably.
    const script = `
      import assert from 'node:assert/strict';
      import { extractFrameworkRouteEvidence } from './src/audit/extractors/graphRoutes.ts';
      for (const size of [50000, 100000, 200000]) {
        const source = "const routes: Routes = [{path: 'far', " + 'loadChildren:'.repeat(size) + '}];';
        const result = extractFrameworkRouteEvidence('src/app/routes.ts', source, new Map());
        assert.deepEqual(result.routes, [{path:'/far', handler:'src/app/routes.ts'}]);
        assert.deepEqual(result.calls, []);
      }
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
      cwd: process.cwd(), encoding: "utf8", timeout: 8000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 12000);

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
    const filler = " ".repeat(300);
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
 * A bounded subprocess checks growing inputs and exact empty evidence. The old
 * quadratic scanners exceed the ceiling; the linear scans have ample headroom.
 * Unlike a millisecond doubling ratio, the ceiling tolerates CI scheduling noise.
 */
function expectBoundedBindingScan(marker: string): void {
  const script = `
    import assert from 'node:assert/strict';
    import { extractRegisteredRouteEvidence } from './src/audit/extractors/graphRoutes.ts';
    for (const size of [100000, 200000, 400000]) {
      const source = 'export const routes = 0;\\n' + ${JSON.stringify(marker)}.repeat(size);
      const result = extractRegisteredRouteEvidence('src/app/routes.ts', source, new Map());
      assert.deepEqual(result.routes, []);
      assert.deepEqual(result.calls, []);
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 8000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("the import-binding clause scan is linear on adversarial input", () => {
  it("scans a marker run with no completing `from` without quadratic backtracking", () => {
    expectBoundedBindingScan("import ");
  }, 12000);

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
    expectBoundedBindingScan("const { ");
  }, 12000);

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

it("preserves alias case, colon, and multiline initializer boundaries", () => {
  const lookup = new Map([["src/handler.ts", "src/handler.ts"]]);
  for (const binding of ["exported AS local", "exported : local", "exported: local = fallback", "exported: local\n = fallback"]) {
    const source = `const { ${binding} } = require('./handler'); router.get('/ok', local)`;
    expect(extractRegisteredRouteEvidence("src/app.ts", source, lookup).routes[0]?.handler).toBe("src/handler.ts");
  }
  const source = "const { local =\n fallback } = require('./handler'); router.get('/ok', local)";
  expect(extractRegisteredRouteEvidence("src/app.ts", source, lookup).routes[0]?.handler).toBe("src/app.ts");
});
