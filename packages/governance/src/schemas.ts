import { z } from "zod";

// ──────────────────────────────────────────────────────────────
// Common building blocks
// ──────────────────────────────────────────────────────────────
const TagMap = z.record(z.string());
const StringArray = z.array(z.string());

// ──────────────────────────────────────────────────────────────
// Resource-specific policy schemas (per create_* node)
// Keep requireds minimal; prefer guidance & validation over rejection.
// ──────────────────────────────────────────────────────────────
export const CreateRgPolicySchema = z.object({
  deny_names: StringArray.optional(),
  deny_contains: StringArray.optional(),
  deny_regex: z.string().optional(),
  name_regex: z.string().optional(),
  allowed_regions: StringArray.optional(),
  require_tags: StringArray.optional(),
  suggest_name: z.string().optional(),
  suggest_region: z.string().optional(),
  suggest_tags: TagMap.optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateStorageAccountPolicySchema = z.object({
  name_regex: z.string().optional(),
  allowed_skus: StringArray.optional(), // e.g. Standard_LRS, Standard_GRS
  min_tls_version: z.enum(["1.0", "1.1", "1.2", "1.3"]).optional(),
  require_https_traffic_only: z.boolean().optional(),
  allow_shared_key_access: z.boolean().optional(),
  public_network_access: z.enum(["Enabled", "Disabled"]).optional(),
  require_private_endpoints: z.boolean().optional(),
  require_tags: StringArray.optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateKeyVaultPolicySchema = z.object({
  name_regex: z.string().optional(),
  sku_allowed: StringArray.optional(), // e.g. standard, premium
  public_network_access: z.enum(["Enabled", "Disabled"]).optional(),
  purge_protection_required: z.boolean().optional(),
  soft_delete_required: z.boolean().optional(),
  rbac_authorization_required: z.boolean().optional(),
  network_bypass_allowed: StringArray.optional(), // e.g. AzureServices
  require_private_endpoints: z.boolean().optional(),
  require_tags: StringArray.optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateLogAnalyticsPolicySchema = z.object({
  workspace_sku_allowed: StringArray.optional(), // e.g. PerGB2018
  retention_days_min: z.number().int().positive().optional(),
  allowed_regions: StringArray.optional(),
  require_tags: StringArray.optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateVnetPolicySchema = z.object({
  address_space_cidr_required: z.boolean().optional(),
  allowed_regions: StringArray.optional(),
  ddos_protection_required: z.boolean().optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateSubnetPolicySchema = z.object({
  service_endpoints_allowed: StringArray.optional(),
  private_endpoint_network_policies: z.enum(["Enabled", "Disabled"]).optional(),
  delegations_allowed: StringArray.optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreatePrivateEndpointPolicySchema = z.object({
  require_manual_approval: z.boolean().optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateAppServicePlanPolicySchema = z.object({
  sku_allowed: StringArray.optional(), // e.g. B1, P1v3
  zone_redundancy_required: z.boolean().optional(),
  controls: StringArray.optional(),
}).passthrough();

export const CreateWebAppPolicySchema = z.object({
  https_only_required: z.boolean().optional(),
  min_tls_version: z.enum(["1.0", "1.1", "1.2", "1.3"]).optional(),
  ftps_state_allowed: StringArray.optional(), // e.g. Disabled, FtpsOnly
  managed_identity_required: z.boolean().optional(),
  diagnostic_settings_required: z.boolean().optional(),
  controls: StringArray.optional(),
}).passthrough();

// ──────────────────────────────────────────────────────────────
// Azure policy set schema (per service create_* node)
// ──────────────────────────────────────────────────────────────
export const AzurePolicySetSchema = z.object({
  create_resource_group: CreateRgPolicySchema.optional(),
  create_storage_account: CreateStorageAccountPolicySchema.optional(),
  create_key_vault: CreateKeyVaultPolicySchema.optional(),
  create_log_analytics_workspace: CreateLogAnalyticsPolicySchema.optional(),
  create_virtual_network: CreateVnetPolicySchema.optional(),
  create_subnet: CreateSubnetPolicySchema.optional(),
  create_private_endpoint: CreatePrivateEndpointPolicySchema.optional(),
  create_app_service_plan: CreateAppServicePlanPolicySchema.optional(),
  create_web_app: CreateWebAppPolicySchema.optional(),
}).catchall(z.unknown()); // permissive overall

// Strict version to detect unknown keys as warnings
export const AzurePolicySetSchemaStrict = z.object({
  create_resource_group: CreateRgPolicySchema.strict().optional(),
  create_storage_account: CreateStorageAccountPolicySchema.strict().optional(),
  create_key_vault: CreateKeyVaultPolicySchema.strict().optional(),
  create_log_analytics_workspace: CreateLogAnalyticsPolicySchema.strict().optional(),
  create_virtual_network: CreateVnetPolicySchema.strict().optional(),
  create_subnet: CreateSubnetPolicySchema.strict().optional(),
  create_private_endpoint: CreatePrivateEndpointPolicySchema.strict().optional(),
  create_app_service_plan: CreateAppServicePlanPolicySchema.strict().optional(),
  create_web_app: CreateWebAppPolicySchema.strict().optional(),
}).strict();

// ──────────────────────────────────────────────────────────────
// ATO schemas (unchanged, permissive)
// ──────────────────────────────────────────────────────────────
export const AtoCheckSchema = z.object({
  code: z.string(),
  title: z.string().optional(),
  severity: z.union([
    z.literal("high"), z.literal("medium"), z.literal("low"), z.literal("info"), z.literal("unknown"), z.string()
  ]).optional(),
  controls: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  fix: z.unknown().optional(),
}).passthrough();

const AtoCheckListOrMap = z.union([z.array(AtoCheckSchema), z.record(AtoCheckSchema)]);

export const AtoSchema = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.object({
    checks: z.record(AtoCheckListOrMap).optional(),
  }).catchall(z.unknown())).optional(),
  checks: z.record(AtoCheckListOrMap).optional(),
}).passthrough();

export const AtoSchemaStrict = z.object({
  defaultProfile: z.string().optional(),
  profiles: z.record(z.object({
    checks: z.record(AtoCheckListOrMap).optional(),
  }).strict()).optional(),
  checks: z.record(AtoCheckListOrMap).optional(),
}).strict();

// ──────────────────────────────────────────────────────────────
// Top-level governance docs
// ──────────────────────────────────────────────────────────────
export const GovernanceDocSchema = z.object({
  azure: AzurePolicySetSchema.optional(),
  ato: AtoSchema.optional(),
}).passthrough();

export const GovernanceDocSchemaStrict = z.object({
  azure: AzurePolicySetSchemaStrict.optional(),
  ato: AtoSchemaStrict.optional(),
}).strict();

export const PolicyOnlySchema = z.object({ azure: AzurePolicySetSchema }).passthrough();
export const PolicyOnlySchemaStrict = z.object({ azure: AzurePolicySetSchemaStrict }).strict();
export const AtoOnlySchema = z.object({ ato: AtoSchema }).passthrough();
export const AtoOnlySchemaStrict = z.object({ ato: AtoSchemaStrict }).strict();

export type GovernanceDoc = z.infer<typeof GovernanceDocSchema>;