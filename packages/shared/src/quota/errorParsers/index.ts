export type { ErrorParser } from "./genericErrorParser.js";
export { GenericErrorParser } from "./genericErrorParser.js";
export { ClaudeCodeErrorParser } from "./claudeCodeErrorParser.js";

import type { ErrorParser } from "./genericErrorParser.js";
import { GenericErrorParser } from "./genericErrorParser.js";
import { ClaudeCodeErrorParser } from "./claudeCodeErrorParser.js";

// Error parsers are stateless, so a single shared instance per provider is
// enough — allocate each once at module scope rather than per call. (Previously
// the claude-code parser was re-allocated on every lookup while the others were
// already singletons; this makes the factory uniform.)
const genericParser = new GenericErrorParser();
const claudeCodeParser = new ClaudeCodeErrorParser();

const PROVIDER_PARSERS: Record<string, ErrorParser> = {
  "claude-code": claudeCodeParser,
};

export function getErrorParserForProvider(providerName: string): ErrorParser {
  return PROVIDER_PARSERS[providerName] ?? genericParser;
}
