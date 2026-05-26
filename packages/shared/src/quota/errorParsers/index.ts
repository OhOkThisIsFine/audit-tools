export type { ErrorParser } from "./genericErrorParser.js";
export { GenericErrorParser } from "./genericErrorParser.js";
export { ClaudeCodeErrorParser } from "./claudeCodeErrorParser.js";

import type { ErrorParser } from "./genericErrorParser.js";
import { GenericErrorParser } from "./genericErrorParser.js";
import { ClaudeCodeErrorParser } from "./claudeCodeErrorParser.js";

const PROVIDER_PARSERS: Record<string, () => ErrorParser> = {
  "claude-code": () => new ClaudeCodeErrorParser(),
};

const genericParser = new GenericErrorParser();

export function getErrorParserForProvider(providerName: string): ErrorParser {
  const factory = PROVIDER_PARSERS[providerName];
  return factory ? factory() : genericParser;
}
