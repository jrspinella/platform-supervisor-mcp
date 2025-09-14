Part A — Platform Engineer flow

A1. Governance deny (fast check)

You say (in Copilot):

@platform Create a resource group named rg-cookies in usgovvirginia.

Expect: Governance DENY (name blacklist) + suggestion.

⸻

A2. Resource Group (plan → confirm)

You say:

@platform Create a resource group named rg-ml-sbx-jrs in usgovvirginia with tags {"owner":"jrs@contoso.gov","env":"dev"}. 

Then:

Confirm yes.

Expect: ✅ Success (with masked subscription).

⸻

A3. App Service Plan (plan → confirm)

You say:

@platform Create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs in location usgovvirginia with SKU P1v3.

Expect: Governance DENY (SKU blacklist) + suggestion.

Then:

@platform Ok, create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, SKU P1

⸻

A4. Web App (plan → confirm)

You say:

Create a Web App web-ml-sbx-jrs on plan plan-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, runtime NODE|20-lts. Plan only.

Then:

Confirm yes.

Expect: May see ATO WARN (HTTPS-only, min TLS, diagnostics). That’s advisory.

⸻

A5. Enable Managed Identity

You say:

Enable system-assigned identity for web-ml-sbx-jrs in rg-ml-sbx-jrs. Confirm yes.

⸻

A6. Storage & Log Analytics

You say:

Create a Storage Account stmlsbxjrs01 in rg-ml-sbx-jrs location usgovvirginia, sku Standard_LRS, kind StorageV2. Plan only.

Then:

Confirm yes.

You say:

Create a Log Analytics workspace law-ml-sbx-jrs in rg-ml-sbx-jrs, retention 30 days. Confirm yes.

⸻

A7. ATO scan — workloads (read-only)

You say:

Scan App workloads in rg-ml-sbx-jrs for ATO warnings.

Expect: Short findings list (e.g., HTTPS-only/TLS/diagnostics). No raw JSON.

(Optional remediation if you wired config tools)
You say:

Enable HTTPS-only and set minimum TLS version 1.2 for web-ml-sbx-jrs. Confirm yes.

⸻

Part B — Developer flow

B1. Repository from template (plan → confirm)

You say:

Create a new repo ml-svc-jdoe in org navy-dev from the template navy-platform/web-node-api, make it private, description “ML service API”. Plan only.

Then:

Confirm yes.

Expect: ✅ Repo URL returned.

⸻

B2. Static Web App (plan → confirm)

You say:

Create a Static Web App swa-ml-sbx-jrs in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Then:

Confirm yes.

⸻

B3. Link SWA to repo (plan → confirm)

You say:

Link swa-ml-sbx-jrs in rg-ml-sbx-jrs to navy-dev/ml-svc-jdoe on branch main, appLocation “/”, output “dist”. Plan only.

Then:

Confirm yes.

Expect: Notes about GitHub Actions workflow & token secret needs.

⸻

Part C — Onboarding (natural language)

C1. Dry run preview

You say:

Onboard jdoe@contoso.gov alias jdoe in usgovvirginia. Dry run only.

Expect: Checklist preview + confirm hint.

⸻

C2. Execute onboarding

You say:

Execute the onboarding checklist for jdoe@contoso.gov alias jdoe in usgovvirginia. Confirm yes, dry run false.

Expect: ✅ Task-by-task summary with any governance advisories.

⸻

Part D — (Optional) ATO scan networks

(Run if you already have VNets/Subnets/NSGs in the RG)

You say:

Scan networks in rg-ml-sbx-jrs for ATO warnings.

Expect: Findings referencing private endpoints, NSG rules, public IPs, with remediation pointers.

⸻

Part E — Wrap-up

You say:

Summarize everything created today and list any remaining ATO warnings with fixes.

Expect: High-level recap (masked IDs), remaining actions (HTTPS/TLS/Diagnostics/PE), and quick-fix guidance.   Developer Flow (using PeDemoOrg/ModernUIRepository)

Option 1 — Use it as the template source

B1. Create repo from template (plan → confirm)

Create a new repo modern-ui-sbx-jdoe in org PeDemoOrg from the template PeDemoOrg/ModernUIRepository, make it private, description “Modern UI service (sandbox) for jdoe”. Plan only.

Confirm yes.

B2. Create Static Web App (plan → confirm)

Create a Static Web App swa-modern-ui-jdoe in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Confirm yes.

B3. Link SWA to the new repo (plan → confirm)

Link swa-modern-ui-jdoe in rg-ml-sbx-jrs to PeDemoOrg/modern-ui-sbx-jdoe on branch main, appLocation “/”, output “dist”. Plan only.

Confirm yes.

⸻

Option 2 — Treat PeDemoOrg/ModernUIRepository as an existing repo

B1’. (Skip template) Just validate repo exists

Check if the GitHub repo PeDemoOrg/ModernUIRepository exists and summarize the default branch and last commit.

B2’. Create Static Web App (plan → confirm)

Create a Static Web App swa-modern-ui in rg-ml-sbx-jrs, location usgovvirginia, sku Free. Plan only.

Confirm yes.

B3’. Link SWA to existing repo (plan → confirm)

Link swa-modern-ui in rg-ml-sbx-jrs to PeDemoOrg/ModernUIRepository on branch main, appLocation “/”, output “dist”. Plan only.

Confirm yes.

⸻

Optional GitHub hardening (nice for managers to see)

For PeDemoOrg/modern-ui-sbx-jdoe, enable branch protection on main requiring PR reviews and status checks, and enable Dependabot security updates. Plan only.

Confirm yes.

⸻

Optional: ATO scan after deployment linkage

Scan App workloads in rg-ml-sbx-jrs for ATO warnings and list fixes only (no raw JSON).