import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseArgv, USAGE_EXIT } from "../scripts/shared/argvGuard.mjs";
import { extractGoWorkspaceModuleEdges } from "../dist/audit/extractors/graphManifestEdges/go.js";

test("the separator preserves flag-like positionals without resetting capacity", () => {
  const accepted = parseArgv(["first", "--", "--help"], { positionals: 2 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.help, false);
  assert.deepEqual(accepted.positionals, ["first", "--help"]);

  const excess = parseArgv(["first", "--", "second"], { positionals: 1 });
  assert.equal(excess.ok, false);
  assert.deepEqual(excess.positionals, ["first"]);
  assert.deepEqual(excess.unknown, ["second"]);

  const variadic = parseArgv(["--", "--help", "--", "third"], { positionals: Infinity });
  assert.equal(variadic.ok, true);
  assert.deepEqual(variadic.positionals, ["--help", "--", "third"]);
});

test("guardArgv refuses excess inert data before reaching CLI work", () => {
  const guardUrl = new URL("../scripts/shared/argvGuard.mjs", import.meta.url);
  const program = `
    import { guardArgv } from ${JSON.stringify(guardUrl.href)};
    guardArgv(process.argv.slice(1), { name: "fixture", usage: "fixture" });
    console.log("CLI work reached");
  `;
  const run = (...args) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", program, "--", ...args], { encoding: "utf8" });

  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /CLI work reached/);

  const excess = run("--", "garden");
  assert.equal(excess.status, USAGE_EXIT, excess.stderr);
  assert.equal(excess.stdout, "");
  assert.match(excess.stderr, /unrecognized argument\(s\) "garden"/);
});

function workspaceTargets(content, paths) {
  const lookup = new Map(paths.map((path) => [path.toLowerCase(), path]));
  return extractGoWorkspaceModuleEdges("go.work", content, lookup).map((edge) => edge.to);
}

test("workspace blocks ignore quoted parentheses and comments on both kinds of line", () => {
  const workspace = [
    'use ( "./first) module" // ) ./comment',
    '  // ) ./comment',
    '  `./second) module`',
    '  ./third',
    ') // ./comment',
    'use ( `./inline) module` ) // ./comment',
    'use "./solo) module" // ./comment',
    'go 1.22',
  ].join("\r\n");
  const expected = [
    "first) module/go.mod",
    "second) module/go.mod",
    "third/go.mod",
    "inline) module/go.mod",
    "solo) module/go.mod",
  ];
  assert.deepEqual(workspaceTargets(workspace, [...expected, "comment/go.mod", "go/go.mod"]), expected);
});

test("workspace parsing discards malformed quoted tokens without consuming later directives", () => {
  const workspace = [
    'use (',
    '  "./unfinished)',
    '  "./joined"tail',
    '  `./two``parts`',
    String.raw`  "./bad\q"`,
    '  ./real',
    ')',
    'use ./solo // ./comment',
    'use (',
    '  ./unclosed-block',
  ].join("\n");
  const expected = ["real/go.mod", "solo/go.mod"];
  assert.deepEqual(workspaceTargets(workspace, [
    ...expected,
    '"./unfinished)/go.mod',
    'unfinished)/go.mod',
    '"./joined"tail/go.mod',
    'two``parts/go.mod',
    'bad/q/go.mod',
    'comment/go.mod',
    'unclosed-block/go.mod',
  ]), expected);
});
