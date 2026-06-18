export const CLOSING_ACTIONS = [
  "commit",
  "push",
  "open-pr",
  "publish",
  "tag",
  "none",
  "custom",
] as const;

export type ClosingAction = (typeof CLOSING_ACTIONS)[number];
