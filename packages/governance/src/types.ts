export type Check =
    | { type: "regex"; path: string; pattern: string; message?: string }
    | { type: "noSpaces"; path: string; message?: string }
    | { type: "allowedValues"; path: string; values: string[]; message?: string }
    | { type: "requiredTags"; path: string; keys: string[]; message?: string };


export type Policy = {
    id: string;
    description?: string;
    target: { tool?: string; prefix?: string };
    effect: "deny" | "warn" | "allow";
    checks: Check[];
};


export type EvalResult = {
    decision: "deny" | "warn" | "allow";
    reasons: string[];
    policyIds: string[];
};