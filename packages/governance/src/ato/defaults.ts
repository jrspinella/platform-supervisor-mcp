import type { AtoProfiles } from "./types";

export const DEFAULT_ATO_PROFILES: AtoProfiles = {
  default: {
    // ───────────────────────────
    // Web App (scanner domain: "webapp")
    // ───────────────────────────
    webapp: {
      rules: {
        APP_TLS_MIN_BELOW_1_2:      { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
        APP_HTTPS_ONLY_DISABLED:    { controls: ["SC-23"],         suggest: "Enable HTTPS-only on the Web App." },
        APP_FTPS_NOT_DISABLED:      { controls: ["CM-7"],          suggest: "Disable FTPS (set ftpsState: Disabled)." },
        APP_MSI_DISABLED:           { controls: ["AC-3", "IA-2"],  suggest: "Enable system-assigned identity on the Web App." },
        APP_DIAG_NO_LAW:            { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },

    // ───────────────────────────
    // App Service Plan (scanner domain: "appPlan")
    // ───────────────────────────
    appPlan: {
      rules: {
        APPPLAN_HTTPS_ONLY_DISABLED: { controls: ["SC-23"],         suggest: "Enable HTTPS-only on the App Service Plan." },
        APPPLAN_FTPS_NOT_DISABLED:   { controls: ["CM-7"],          suggest: "Disable FTPS on the plan (set ftpsState: Disabled)." },
        APPPLAN_MSI_DISABLED:        { controls: ["AC-3", "IA-2"],  suggest: "Enable system-assigned identity on the App Service Plan." },
        APPPLAN_DIAG_NO_LAW:         { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
        // (optional) Only include if your scanner ever emits it:
        // APPPLAN_MIN_TLS_BELOW_1_2:   { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
      },
    },

    // ───────────────────────────
    // Storage Account (scanner domain: "storageAccount")
    // Scanner emits STG_* (not STOR_*)
    // ───────────────────────────
    storageAccount: {
      rules: {
        STG_HTTPS_ONLY_DISABLED:        { controls: ["SC-23"],         suggest: "Enable HTTPS only on the Storage Account." },
        STG_MIN_TLS_BELOW_1_2:          { controls: ["SC-13", "SC-8"], suggest: "Set minimum TLS version to 1.2 and disable legacy protocols." },
        STG_BLOB_PUBLIC_ACCESS_ENABLED: { controls: ["AC-3", "AC-6"],  suggest: "Disable blob public access on the Storage Account." },
      },
    },

    // ───────────────────────────
    // Key Vault (scanner domain: "keyVault")
    // Align codes to scanner outputs
    // ───────────────────────────
    key_vault: {
      rules: {
        KV_RBAC_NOT_ENABLED:         { controls: ["AC-3", "AC-6"],  suggest: "Enable RBAC authorization on the Key Vault." },
        KV_PUBLIC_NETWORK_ENABLED:   { controls: ["SC-7"],          suggest: "Disable public network access on the Key Vault." },
        KV_PURGE_PROTECTION_DISABLED:{ controls: ["SI-12"],         suggest: "Enable purge protection on the Key Vault." },
        KV_SOFT_DELETE_DISABLED:     { controls: ["SI-12"],         suggest: "Enable soft delete on the Key Vault." },
        // (optional extras if you later emit them):
        // KV_DIAG_NO_LAW:            { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
        // KV_MSI_DISABLED:           { controls: ["AC-3", "IA-2"],  suggest: "Enable system-assigned identity on the Key Vault." },
      },
    },

    // ───────────────────────────
    // Log Analytics (scanner domain: "logAnalytics")
    // ───────────────────────────
    logAnalyticsWorkspace: {
      rules: {
        LAW_RETENTION_TOO_LOW: { controls: ["AU-11"], suggest: "Increase Log Analytics retention to at least 30 days." },
      },
    },

    // ───────────────────────────
    // Network (scanner domain: "network")
    // ───────────────────────────
    network: {
      rules: {
        NET_DDOS_DISABLED:          { controls: ["SC-5"], suggest: "Enable Azure DDoS Protection on the VNet if required by policy." },
        SUBNET_PENP_NOT_DISABLED:   { controls: ["SC-7"], suggest: "Disable private endpoint network policies on subnets used for Private Endpoints." },
        // (your extra controls can remain here, but scanners must emit matching codes)
        // VNET_PE_NO_PRIVATE_DNS:   { controls: ["SC-7"], suggest: "Use Private DNS zones with Private Endpoints." },
        // VNET_SUBNET_DELEG_NOT_SET:{ controls: ["SC-7"], suggest: "Set subnet delegation where applicable." },
        // VNET_SUBNET_NSG_MISSING:  { controls: ["SC-7"], suggest: "Associate an NSG with the subnet." },
        // VNET_DIAG_NO_LAW:         { controls: ["AU-6", "AU-12"], suggest: "Enable diagnostic settings to a Log Analytics Workspace." },
      },
    },

    // ───────────────────────────
    // Resource Group (scanner domain: "resourceGroup")
    // ───────────────────────────
    resourceGroup: {
      rules: {
        RG_TAGS_MISSING: { controls: ["CM-6"], suggest: "Apply required tags to the Resource Group." },
      },
    },
  },
};
