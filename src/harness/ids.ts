export const HARNESS_IDS = ["openclaw"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const DEFAULT_HARNESS_ID: HarnessId = "openclaw";
