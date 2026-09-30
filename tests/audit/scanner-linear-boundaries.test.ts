import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { expect, test } from "vitest";

test("public scanners keep semantics under growing malformed inputs within a bounded process", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { extractRegisteredRouteEvidence, extractFrameworkRouteEvidence } from './src/audit/extractors/graphRoutes.ts';
    import { extractPythonImportEdges } from './src/audit/extractors/graphPythonImports.ts';
    for (const n of [20000, 40000, 80000]) {
      const lookup = new Map([['src/handler.ts', 'src/handler.ts']]);
      assert.deepEqual(extractRegisteredRouteEvidence('src/app.ts', 'import { h' + ' '.repeat(n) + 'oops } from "./handler"; router.get("/ok", h)', lookup).routes,
        [{method:'GET', path:'/ok', handler:'src/app.ts'}]);
      assert.deepEqual(extractFrameworkRouteEvidence('src/app.ts', '@Controller("base") class X { @Get("a' + '/'.repeat(n) + 'z") get() {} }', lookup).routes.map(r => r.path), ['/base/a/z']);
      assert.deepEqual(extractPythonImportEdges('src/app.py', 'from .handler import name' + ' '.repeat(n) + 'as broken!', new Map([['src/handler.py','src/handler.py']] )).map(e => e.to), ['src/handler.py']);
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 12000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 15000);
