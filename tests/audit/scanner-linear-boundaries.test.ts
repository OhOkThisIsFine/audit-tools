import { runAfterReadyWithDeadline } from "../helpers/spawn.mjs";
import { expect, test } from "vitest";

test("public scanners keep semantics under growing malformed inputs within a bounded process", async () => {
  // The deadline times the scans only; the child's start is not timed
  // (runAfterReadyWithDeadline in tests/helpers/trackedSpawn.ts says why).
  const result = await runAfterReadyWithDeadline({
    imports: `
    import assert from 'node:assert/strict';
    import { extractRegisteredRouteEvidence, extractFrameworkRouteEvidence } from './src/audit/extractors/graphRoutes.ts';
    import { extractPythonImportEdges } from './src/audit/extractors/graphPythonImports.ts';
    `,
    body: `
    for (const n of [20000, 40000, 80000]) {
      const lookup = new Map([['src/handler.ts', 'src/handler.ts']]);
      assert.deepEqual(extractRegisteredRouteEvidence('src/app.ts', 'import { h' + ' '.repeat(n) + 'oops } from "./handler"; router.get("/ok", h)', lookup).routes,
        [{method:'GET', path:'/ok', handler:'src/app.ts'}]);
      assert.deepEqual(extractFrameworkRouteEvidence('src/app.ts', '@Controller("base") class X { @Get("a' + '/'.repeat(n) + 'z") get() {} }', lookup).routes.map(r => r.path), ['/base/a/z']);
      assert.deepEqual(extractPythonImportEdges('src/app.py', 'from .handler import name' + ' '.repeat(n) + 'as broken!', new Map([['src/handler.py','src/handler.py']] )).map(e => e.to), ['src/handler.py']);
    }
  `,
  }, 12000);
  expect(result.timedOut, result.stderr).toBe(false);
  expect(result.status, result.stderr).toBe(0);
});
