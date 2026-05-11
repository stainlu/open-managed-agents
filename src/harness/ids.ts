export const HARNESS_IDS = ["openclaw", "hermes", "codex", "claude-agent-sdk", "flue"] as const;
export type BuiltinHarnessId = (typeof HARNESS_IDS)[number];
export type HarnessId = string;

export const DEFAULT_HARNESS_ID: HarnessId = "openclaw";
