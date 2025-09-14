// packages/governance-core/src/ato/types.ts
export type AtoRule = {
  controls: string[];
  suggest: string;
};

export type AtoRuleSet = {
  rules: Record<string, AtoRule>;
};

export type AtoProfile = {
  webapp?: AtoRuleSet;
  appPlan?: AtoRuleSet;
  functionApp?: AtoRuleSet;
  storageAccount?: AtoRuleSet;
  sqlDatabase?: AtoRuleSet;
  network?: AtoRuleSet;
  key_vault?: AtoRuleSet;
  logAnalyticsWorkspace?: AtoRuleSet;
  resourceGroup?: AtoRuleSet;
};

export type AtoProfiles = Record<string, AtoProfile>;