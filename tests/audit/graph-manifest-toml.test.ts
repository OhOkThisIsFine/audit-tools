import { expect, test } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { parseTomlSafe, asTomlTable } from "../../src/audit/extractors/graphManifestEdges/toml.js";

// The parser is synchronous: an in-worker timeout cannot interrupt its loop.
// Each hostile/scaling case runs in one owned Node child, with an OS deadline
// and SIGKILL, and spawnSync waits for that direct child to be reaped.
function parserChild(body: string, timeout = 10_000): string {
  const moduleUrl = new URL("../../dist/audit/extractors/graphManifestEdges/toml.js", import.meta.url).href;
  const child = spawnSyncHidden(process.execPath, ["--input-type=module", "-e",
    `import assert from 'node:assert/strict'; import { parseTomlSafe } from ${JSON.stringify(moduleUrl)}; ${body}`],
  { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  expect(child.error, `external parser watchdog: ${String(child.error)}; ${child.stderr}`).toBeUndefined();
  expect(child.signal, child.stderr).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

test.each(["a=[1 #", "a={b=1 #"])("EOF-comment advisory terminates with empty fallback: %s", (input) => {
  parserChild(`assert.deepEqual(parseTomlSafe(${JSON.stringify(input)}), {});`);
});

test("dot-free key parsing has bounded repeated scaling and preserves every key", () => {
  const output = parserChild(`
    const sizes = [8000, 16000, 32000];
    const documents = sizes.map(n => Array.from({length:n}, (_,i) => 'k'+i+' = 1').join('\\n'));
    const samples = sizes.map(() => []);
    const wall = sizes.map(() => []);
    for (let round=0; round<5; round++) for (let j=0; j<sizes.length; j++) {
      const start = performance.now(), cpu = process.cpuUsage();
      // Batch short parses so Windows CPU accounting spans several clock ticks.
      const repetitions = 16;
      for (let repeat=0; repeat<repetitions; repeat++) {
        const result = parseTomlSafe(documents[j]);
        assert.equal(Object.keys(result).length, sizes[j]);
        assert.equal(result['k'+(sizes[j]-1)], 1);
      }
      const used = process.cpuUsage(cpu);
      const elapsed = performance.now()-start;
      if(round>=2) { samples[j].push((used.user+used.system)/1000/repetitions); wall[j].push(elapsed/repetitions); }
    }
    const median = values => [...values].sort((a,b)=>a-b)[1];
    const cpuMs = samples.map(median);
    console.log(JSON.stringify({sizes,cpuMs,wallMs:wall.map(median),maxRssKb:process.resourceUsage().maxRSS}));
    // Fourfold input growth is linear after the patch, rather than sixteenfold.
    // CPU medians avoid scheduler pauses; an additive floor covers clock/GC noise.
    assert(cpuMs[2] <= cpuMs[0]*10+10, 'quadratic growth: '+JSON.stringify(cpuMs));
  `, 30_000);
  const measurements = JSON.parse(output);
  expect(measurements.sizes).toEqual([8000, 16000, 32000]);
  expect(measurements.maxRssKb).toBeGreaterThan(0);
  console.log("TOML scaling", measurements);
});

test("TOML tables preserve prototype-shaped keys without polluting Object.prototype", () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const parsed = parseTomlSafe('constructor = "value"\nhasOwnProperty = "own"\n[__proto__]\npolluted = true\n');
  expect(Object.getPrototypeOf(parsed)).toBeNull();
  expect(Object.getPrototypeOf(parsed.__proto__)).toBeNull();
  expect(parsed.constructor).toBe("value");
  expect(parsed.hasOwnProperty).toBe("own");
  expect(asTomlTable(parsed.__proto__)?.polluted).toBe(true);
  expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(asTomlTable(Object.assign(Object.create(null), { members: ["a"] }))?.members).toEqual(["a"]);
  expect(asTomlTable(null)).toBeUndefined();
  expect(asTomlTable([])).toBeUndefined();
  expect(parseTomlSafe("a = =")).toEqual({});
});
