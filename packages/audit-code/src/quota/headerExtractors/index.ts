export type { HeaderExtractor } from "./genericHeaderExtractor.js";
export { GenericHeaderExtractor } from "./genericHeaderExtractor.js";
export { ClaudeCodeHeaderExtractor } from "./claudeCodeHeaderExtractor.js";

import type { HeaderExtractor } from "./genericHeaderExtractor.js";
import { GenericHeaderExtractor } from "./genericHeaderExtractor.js";
import { ClaudeCodeHeaderExtractor } from "./claudeCodeHeaderExtractor.js";

const PROVIDER_EXTRACTORS: Record<string, () => HeaderExtractor> = {
  "claude-code": () => new ClaudeCodeHeaderExtractor(),
};

const genericExtractor = new GenericHeaderExtractor();

export function getHeaderExtractorForProvider(providerName: string): HeaderExtractor {
  const factory = PROVIDER_EXTRACTORS[providerName];
  return factory ? factory() : genericExtractor;
}
