export type TemplateInput = {
  key: string;
  title?: string;
  required?: boolean;
  default?: any;
  pattern?: string;
  enum?: string[];
  description?: string;
};

export type TemplateManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputs: TemplateInput[];
  // Actions describe what to do at mint time
  actions?: {
    github?: {
      createRepo?: boolean;
      repoNameFrom?: string;         // e.g. "projectName" or "alias"
      private?: boolean;
      defaultBranch?: string;
      addCodeowners?: boolean;
      enableSecurity?: boolean;      // secret scanning, dependabot, push-protection
      protectMain?: boolean;
    };
    platform?: {
      // minimal baseline – you can extend with more actions
      createRg?: boolean;
      createKv?: boolean;
      regionFrom?: string;           // e.g. "region"
    };
  };
  // Optional controls metadata for docs
  controls?: string[];
};

export type CatalogEntry = {
  id: string;
  path: string;          // absolute dir path
  manifest: TemplateManifest;
};