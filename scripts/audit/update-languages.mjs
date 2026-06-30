import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const linguistLanguages = require("linguist-languages");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LANGUAGE_MAP_FILE = path.join(
  __dirname,
  "../../src/audit/extractors/languageMap.generated.ts",
);

function generateLanguageMap() {
  const map = {};
  const currentPriority = {};
  let conflictCount = 0;

  const getTypePriority = (type) => {
    switch (type) {
      case "programming": return 4;
      case "markup": return 3;
      case "prose": return 2;
      case "data": return 1;
      default: return 0;
    }
  };

  for (const [langName, langData] of Object.entries(linguistLanguages)) {
    if (!langData.extensions) continue;

    const priority = getTypePriority(langData.type);

    for (const ext of langData.extensions) {
      const cleanExt = ext.startsWith(".") ? ext.substring(1) : ext;

      // Resolve conflicts using the rubric: programming > markup > prose > data
      const alreadyClaimed = currentPriority[cleanExt] !== undefined;
      if (alreadyClaimed) {
        // A second (or later) language claims this extension; the rubric decides
        // the winner. Either way it is a resolved conflict.
        conflictCount++;
      }
      if (!alreadyClaimed || priority > currentPriority[cleanExt]) {
        map[cleanExt] = langName.toLowerCase();
        currentPriority[cleanExt] = priority;
      }
    }
  }

  return { map, conflictCount };
}

function readPriorExtensionCount() {
  if (!fs.existsSync(LANGUAGE_MAP_FILE)) {
    return 0;
  }
  try {
    const prior = fs.readFileSync(LANGUAGE_MAP_FILE, "utf-8");
    const match = prior.match(
      /LANGUAGE_BY_EXTENSION: Record<string, string> = (\{[\s\S]*?\});/,
    );
    if (!match) return 0;
    return Object.keys(JSON.parse(match[1])).length;
  } catch {
    return 0;
  }
}

function updateFile(map, conflictCount, t0) {
  const startMarker = "// --- AUTO-GENERATED LANGUAGE MAP START ---";
  const endMarker = "// --- AUTO-GENERATED LANGUAGE MAP END ---";
  const mapString = JSON.stringify(map, null, 2);

  const priorCount = readPriorExtensionCount();

  const content =
    `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n` +
    `// Regenerate with: npm run update-languages  (scripts/audit/update-languages.mjs)\n` +
    `// Source data: linguist-languages, conflict rubric programming > markup > prose > data.\n\n` +
    `${startMarker}\n` +
    `export const LANGUAGE_BY_EXTENSION: Record<string, string> = ${mapString};\n` +
    `${endMarker}\n`;

  fs.writeFileSync(LANGUAGE_MAP_FILE, content, "utf-8");

  const elapsedMs = Date.now() - t0;
  const newCount = Object.keys(map).length;
  const added = Math.max(0, newCount - priorCount);
  const removed = Math.max(0, priorCount - newCount);
  console.log(
    `Updated ${LANGUAGE_MAP_FILE}: ${newCount} extensions (was ${priorCount}) — +${added} added, -${removed} removed, ${conflictCount} conflicts resolved. (${elapsedMs}ms)`,
  );
}

const t0 = Date.now();
const { map, conflictCount } = generateLanguageMap();
updateFile(map, conflictCount, t0);
