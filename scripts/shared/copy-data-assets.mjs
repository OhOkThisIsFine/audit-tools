// Copy vendored data assets (JSON snapshots consumed at runtime via fs) from the
// source tree into dist/ after `tsc`. tsc does not emit non-TS assets, and these
// snapshots are deliberately NOT TS literals (see scripts/shared/update-models.mjs),
// so the build must place them alongside the compiled modules that read them.
//
// Runs as part of `npm run build` (chained after tsc).

import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "../..");

// Each entry: a directory under src/ whose *.json assets mirror into dist/.
const ASSET_DIRS = ["shared/data"];

let copied = 0;
for (const rel of ASSET_DIRS) {
  const from = path.join(repoRoot, "src", rel);
  const to = path.join(repoRoot, "dist", rel);
  if (!existsSync(from)) continue;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => src === from || src.endsWith(".json"),
  });
  copied++;
}

// Log to stderr, not stdout: this runs inside `prepack` → `npm pack --json`,
// whose stdout must stay valid JSON for the packaging smoke test to parse.
console.error(`Copied ${copied} data-asset dir(s) into dist/`);
