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
  "../src/extractors/languageMap.generated.ts",
);

function generateLanguageMap() {
  const map = {};
  const currentPriority = {};

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
      if (!currentPriority[cleanExt] || priority > currentPriority[cleanExt]) {
        map[cleanExt] = langName.toLowerCase();
        currentPriority[cleanExt] = priority;
      }
    }
  }

  return map;
}

function updateFile(map) {
  const startMarker = "// --- AUTO-GENERATED LANGUAGE MAP START ---";
  const endMarker = "// --- AUTO-GENERATED LANGUAGE MAP END ---";
  const mapString = JSON.stringify(map, null, 2);

  const content =
    `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.\n` +
    `// Regenerate with: npm run update-languages  (scripts/update-languages.mjs)\n` +
    `// Source data: linguist-languages, conflict rubric programming > markup > prose > data.\n\n` +
    `${startMarker}\n` +
    `export const LANGUAGE_BY_EXTENSION: Record<string, string> = ${mapString};\n` +
    `${endMarker}\n`;

  fs.writeFileSync(LANGUAGE_MAP_FILE, content, "utf-8");
  console.log(`Updated ${LANGUAGE_MAP_FILE} with ${Object.keys(map).length} language extensions.`);
}

const map = generateLanguageMap();
updateFile(map);
