// packages/governance-core/src/ato/defaults.ts
import type { AtoProfiles } from "./types";

export const DEFAULT_ATO_PROFILES: AtoProfiles = {
  default: {
    webapp: {
      rules: {
        APP_TLS_MIN_BELOW_1_2: { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
        APP_HTTPS_ONLY_DISABLED: { controls: ["SC-23"], suggest: "Enable HTTPS-only on the Web App." },
        APP_FTPS_NOT_DISABLED: { controls: ["CM-7"], suggest: "Disable FTPS (set ftpsState: Disabled)." },
        APP_MSI_DISABLED: { controls: ["AC-3", "IA-2"], suggest: "Enable system-assigned identity on the Web App." },
        APP_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },
    appPlan: {
      rules: {
        PLAN_MIN_TLS_BELOW_1_2: { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
      },
    },
    functionApp: {
      rules: {
        FUNC_TLS_MIN_BELOW_1_2: { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
        FUNC_HTTPS_ONLY_DISABLED: { controls: ["SC-23"], suggest: "Enable HTTPS-only on the Function App." },
        FUNC_FTPS_NOT_DISABLED: { controls: ["CM-7"], suggest: "Disable FTPS (set ftpsState: Disabled)." },
        FUNC_MSI_DISABLED: { controls: ["AC-3", "IA-2"], suggest: "Enable system-assigned identity on the Function App." },
        FUNC_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },
    storageAccount: {
      rules: {
        STOR_TLS_MIN_BELOW_1_2: { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
        STOR_HNS_DISABLED: { controls: ["AC-3", "AC-6"], suggest: "Enable Hierarchical Namespace (HNS) on the Storage Account." },
        STOR_MSI_DISABLED: { controls: ["AC-3", "IA-2"], suggest: "Enable system-assigned identity on the Storage Account." },
        STOR_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },
    sqlDatabase: {
      rules: {
        SQL_MSI_DISABLED: { controls: ["AC-3", "IA-2"], suggest: "Enable system-assigned identity on the SQL Server." },
        SQL_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
        SQL_AUDIT_NOT_ENABLED: { controls: ["AU-6", "AU-12"], suggest: "Enable Auditing on the SQL Server to a Log Analytics Workspace." },
      },
    },
    network: {
      rules: {
        VNET_PE_NO_PRIVATE_DNS: { controls: ["SC-7"], suggest: "Use Private DNS zones with Private Endpoints." },
        VNET_SUBNET_DELEG_NOT_SET: { controls: ["SC-7"], suggest: "Set subnet delegation for App Service Environments or Azure Functions." },
        VNET_SUBNET_NSG_MISSING: { controls: ["SC-7"], suggest: "Associate a Network Security Group (NSG) with the subnet." },
        VNET_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },
    key_vault: {
      rules: {
        KV_SOFT_DELETE_DISABLED: { controls: ["SI-12"], suggest: "Enable soft delete on the Key Vault." },
        KV_PURGE_PROT_DISABLED: { controls: ["SI-12"], suggest: "Enable purge protection on the Key Vault." },
        KV_RBAC_DISABLED: { controls: ["AC-3", "AC-6"], suggest: "Enable RBAC authorization on the Key Vault." },
        KV_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
        KV_MSI_DISABLED: { controls: ["AC-3", "IA-2"], suggest: "Enable system-assigned identity on the Key Vault." },
      },
    },
    logAnalyticsWorkspace: {
      rules: {
        LAW_DIAG_NO_LAW: { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },
    resourceGroup: {
      rules: {
        RG_TAGS_MISSING: { controls: ["CM-6"], suggest: "Apply required tags to the Resource Group." },
      },
    },
  },
};