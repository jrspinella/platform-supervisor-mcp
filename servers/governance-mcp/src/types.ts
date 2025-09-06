// governance/src/types.ts

export type Check =
  | { type: "regex"; path: string; pattern: string; message?: string }
  | { type: "noSpaces"; path: string; message?: string }
  | { type: "allowedValues"; path: string; values: string[]; message?: string }
  | { type: "requiredTags"; path: string; keys: string[]; message?: string }
  | { type: "requiredTrue"; path: string; message?: string }
  | { type: "requiredPresent"; path: string; message?: string }
  | { type: "equals"; path: string; value: any; message?: string }
  | { type: "notEquals"; path: string; value: any; message?: string };

export type Suggestion = {
  title?: string;
  text: string;
};

export type Policy = {
  id: string;
  description?: string;
  target: { tool?: string; prefix?: string };
  effect: "deny" | "warn" | "allow";
  checks: Check[];
  suggest?: string | { title?: string; text: string };
};

export type EvalResult = {
  decision: "deny" | "warn" | "allow";
  reasons: string[];
  policyIds: string[];
  suggestions?: Suggestion[];
};